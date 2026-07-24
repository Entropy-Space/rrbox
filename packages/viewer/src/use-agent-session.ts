import {
  createCommand,
  parseCoreEvent,
  type AssistantBlock,
  type CoreEvent,
  type CoreLifecyclePhase,
  type CoreStateSnapshot,
  type FileEntry,
  type ModelSelection,
  type ProjectSummary,
  type ProviderSummary,
  type SessionSummary,
  type TimelineEntry,
  type ViewerCommand,
  type WorkspaceChangeSummary,
  type WorkspaceTransferFile,
} from "@researchbox/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  WorkspaceTransferRequests,
  type WorkspaceExportSnapshot,
} from "./workspace-transfer.ts";

export type AgentSessionState = {
  state_revision: number;
  catalog_revision: number;
  workspace_revision: number;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  providers: ProviderSummary[];
  active_model: ModelSelection;
  active_project_id: string | null;
  active_session_id: string | null;
  input_draft: string;
  input_draft_generation: number;
  pending_input_draft_request_id: string | null;
  input_draft_needs_sync: boolean;
  input_draft_retry_count: number;
  input_draft_cleanup_scope: DraftScope | null;
  pending_prompt: PendingPrompt | null;
  timeline: TimelineEntry[];
  files: FileEntry[];
  current_path: string;
  selected_file: { path: string; content: string } | null;
  core_lifecycle: CoreLifecyclePhase;
  core_status_message: string | null;
  is_ready: boolean;
  is_running: boolean;
  error_message: string | null;
  pending_fs_list: PendingFileSystemRequest | null;
  pending_fs_read: PendingFileSystemRequest | null;
  pending_workspace_refresh: PendingWorkspaceRefresh | null;
};

export const initialAgentSessionState: AgentSessionState = {
  state_revision: 0,
  catalog_revision: 0,
  workspace_revision: 0,
  projects: [],
  sessions: [],
  providers: [],
  active_model: {
    provider_id: "",
    model_id: "",
  },
  active_project_id: null,
  active_session_id: null,
  input_draft: "",
  input_draft_generation: 0,
  pending_input_draft_request_id: null,
  input_draft_needs_sync: false,
  input_draft_retry_count: 0,
  input_draft_cleanup_scope: null,
  pending_prompt: null,
  timeline: [],
  files: [],
  current_path: "/",
  selected_file: null,
  core_lifecycle: "electing",
  core_status_message: null,
  is_ready: false,
  is_running: false,
  error_message: null,
  pending_fs_list: null,
  pending_fs_read: null,
  pending_workspace_refresh: null,
};

type PendingPrompt = {
  request_id: string;
  project_id: string;
  session_id: string | null;
  input_draft: string;
  input_draft_generation: number;
};

type DraftScope = {
  project_id: string;
  session_id: string | null;
};

type PendingFileSystemRequest = {
  request_id: string;
  path: string;
  expected_workspace_revision: number;
  request_kind: "navigation" | "workspace_refresh";
};

type PendingWorkspaceRefresh = {
  workspace_revision: number;
  changed_paths: string[];
};

type AgentSessionAction =
  | CoreEvent
  | ({ type: "fs_list_requested" } & PendingFileSystemRequest)
  | ({ type: "fs_read_requested" } & PendingFileSystemRequest)
  | { type: "workspace_refresh_started"; workspace_revision: number }
  | {
      type: "input_draft_changed";
      request_id: string;
      project_id: string;
      session_id: string | null;
      input_draft: string;
    }
  | {
      type: "input_draft_sync_started";
      request_id: string | null;
      project_id: string;
      session_id: string | null;
      input_draft: string;
    }
  | {
      type: "prompt_submitted";
      request_id: string;
      project_id: string;
      session_id: string | null;
      input_draft: string;
      input_draft_generation: number;
    }
  | { type: "transport_failed"; message: string };

type ManagementCommand = Exclude<
  ViewerCommand,
  {
    type:
      | "bootstrap"
      | "prompt"
      | "input_draft_update"
      | "abort"
      | "fs_list"
      | "fs_read"
      | "project_import"
      | "workspace_export"
      | "workspace_export_cancel";
  }
>;

export function useAgentSession(createWorker: () => Worker) {
  const [coreState, dispatch] = useReducer(
    coreReducer,
    initialAgentSessionState,
  );
  const [transportError, setTransportError] = useState<string | null>(null);
  const [isManagementPending, setManagementPending] = useState(false);
  const [refreshingProviderIds, setRefreshingProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const workerRef = useRef<Worker | null>(null);
  const pendingManagementRequestRef = useRef<string | null>(null);
  const pendingProviderRefreshRequestRef = useRef(new Map<string, string>());
  const workspaceTransferRequestsRef =
    useRef<WorkspaceTransferRequests | null>(null);
  if (workspaceTransferRequestsRef.current === null) {
    workspaceTransferRequestsRef.current = new WorkspaceTransferRequests();
  }
  const lastWorkspaceRefreshRef = useRef<string | null>(null);
  const isInputDraftPending =
    coreState.pending_input_draft_request_id !== null ||
    coreState.input_draft_needs_sync;
  const activeProvider = coreState.providers.find(
    (provider) => provider.provider_id === coreState.active_model.provider_id,
  );
  const activeModel = activeProvider?.models.find(
    (model) => model.model_id === coreState.active_model.model_id,
  );
  const isActiveModelReady =
    activeProvider?.availability === "ready" &&
    activeModel?.availability === "ready";

  const sendCommand = useCallback((command: ViewerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

  useEffect(() => {
    const activeProjectId = coreState.active_project_id;
    if (
      (!coreState.input_draft_needs_sync &&
        coreState.input_draft_cleanup_scope === null) ||
      !activeProjectId
    ) {
      return;
    }
    const retryDelay =
      coreState.input_draft_retry_count === 0
        ? 0
        : Math.min(
            500 * 2 ** (coreState.input_draft_retry_count - 1),
            5_000,
          );
    const retryTimer = window.setTimeout(() => {
      const cleanupCommand = coreState.input_draft_cleanup_scope
        ? createCommand("input_draft_update", {
            ...coreState.input_draft_cleanup_scope,
            input_draft: "",
          })
        : null;
      const syncCommand = coreState.input_draft_needs_sync
        ? createCommand("input_draft_update", {
            project_id: activeProjectId,
            session_id: coreState.active_session_id,
            input_draft: coreState.input_draft,
          })
        : null;
      dispatch({
        type: "input_draft_sync_started",
        request_id: syncCommand?.request_id ?? null,
        project_id: activeProjectId,
        session_id: coreState.active_session_id,
        input_draft: coreState.input_draft,
      });
      if (cleanupCommand) sendCommand(cleanupCommand);
      if (syncCommand) sendCommand(syncCommand);
    }, retryDelay);
    return () => window.clearTimeout(retryTimer);
  }, [
    coreState.active_project_id,
    coreState.active_session_id,
    coreState.input_draft_cleanup_scope,
    coreState.input_draft,
    coreState.input_draft_needs_sync,
    coreState.input_draft_retry_count,
    sendCommand,
  ]);

  const sendManagementCommand = useCallback(
    (command: ManagementCommand) => {
      pendingManagementRequestRef.current = command.request_id;
      setManagementPending(true);
      sendCommand(command);
    },
    [sendCommand],
  );

  const sendFileSystemCommand = useCallback(
    (
      command: Extract<ViewerCommand, { type: "fs_list" | "fs_read" }>,
      options: Omit<PendingFileSystemRequest, "request_id" | "path">,
    ) => {
      dispatch({
        type:
          command.type === "fs_list"
            ? "fs_list_requested"
            : "fs_read_requested",
        request_id: command.request_id,
        path: command.payload.path,
        ...options,
      });
      sendCommand(command);
    },
    [sendCommand],
  );

  useEffect(() => {
    const refresh = coreState.pending_workspace_refresh;
    const projectId = coreState.active_project_id;
    if (!refresh || !projectId) return;

    const refreshKey = [
      projectId,
      refresh.workspace_revision,
      ...refresh.changed_paths,
    ].join("\0");
    if (lastWorkspaceRefreshRef.current === refreshKey) return;
    lastWorkspaceRefreshRef.current = refreshKey;
    dispatch({
      type: "workspace_refresh_started",
      workspace_revision: refresh.workspace_revision,
    });

    sendFileSystemCommand(
      createCommand("fs_list", {
        project_id: projectId,
        path: coreState.current_path,
      }),
      {
        expected_workspace_revision: refresh.workspace_revision,
        request_kind: "workspace_refresh",
      },
    );

    const selectedPath = coreState.selected_file?.path;
    if (selectedPath && refresh.changed_paths.includes(selectedPath)) {
      sendFileSystemCommand(
        createCommand("fs_read", {
          project_id: projectId,
          path: selectedPath,
        }),
        {
          expected_workspace_revision: refresh.workspace_revision,
          request_kind: "workspace_refresh",
        },
      );
    }
  }, [
    coreState.active_project_id,
    coreState.current_path,
    coreState.pending_workspace_refresh,
    coreState.selected_file?.path,
    sendFileSystemCommand,
  ]);

  useEffect(() => {
    const worker = createWorker();
    const terminateWorker = createWorkerTerminator(worker);
    const failWorker = (message: string) => {
      terminateWorker();
      if (workerRef.current === worker) workerRef.current = null;
      setTransportError(message);
      dispatch({ type: "transport_failed", message });
      pendingManagementRequestRef.current = null;
      pendingProviderRefreshRequestRef.current.clear();
      workspaceTransferRequestsRef.current?.rejectAll(new Error(message));
      setRefreshingProviderIds(new Set());
      setManagementPending(false);
    };
    workerRef.current = worker;
    worker.onmessage = (message: MessageEvent<unknown>) => {
      try {
        const event = parseCoreEvent(message.data);
        const handledWorkspaceTransfer =
          workspaceTransferRequestsRef.current?.accept(event) ?? false;
        if (
          !handledWorkspaceTransfer ||
          event.type === "state_snapshot"
        ) {
          dispatch(event);
        }
        if (
          event.request_id === pendingManagementRequestRef.current &&
          (event.type === "state_snapshot" || event.type === "error")
        ) {
          pendingManagementRequestRef.current = null;
          setManagementPending(false);
        }
        const refreshingProviderId = event.request_id
          ? pendingProviderRefreshRequestRef.current.get(event.request_id)
          : undefined;
        if (refreshingProviderId && event.request_id) {
          const refreshRequestId = event.request_id;
          const provider =
            event.type === "state_snapshot"
              ? event.payload.state.providers.find(
                  (candidate) =>
                    candidate.provider_id === refreshingProviderId,
                )
              : event.type === "provider_catalog_snapshot"
                ? event.payload.providers.find(
                    (candidate) =>
                      candidate.provider_id === refreshingProviderId,
                  )
              : undefined;
          if (event.type === "error" || provider?.availability !== "loading") {
            pendingProviderRefreshRequestRef.current.delete(refreshRequestId);
            setRefreshingProviderIds((current) => {
              const next = new Set(current);
              next.delete(refreshingProviderId);
              return next;
            });
          }
        }
      } catch {
        failWorker("The browser core sent an invalid event.");
      }
    };
    worker.onerror = () => {
      failWorker("The browser core stopped. Refresh to try again.");
    };
    worker.postMessage(createCommand("bootstrap", {}));

    return () => {
      workspaceTransferRequestsRef.current?.rejectAll(
        new Error(
          "The browser core closed before the workspace transfer completed.",
        ),
      );
      terminateWorker();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [createWorker]);

  const submitPrompt = useCallback(
    (prompt: string): boolean => {
      const text = prompt.trim();
      if (
        !text ||
        !coreState.active_project_id ||
        coreState.is_running ||
        coreState.pending_prompt !== null ||
        isManagementPending ||
        !isActiveModelReady
      ) {
        return false;
      }
      const command = createCommand("prompt", {
        project_id: coreState.active_project_id,
        session_id: coreState.active_session_id,
        text,
      });
      dispatch({
        type: "prompt_submitted",
        request_id: command.request_id,
        project_id: command.payload.project_id,
        session_id: command.payload.session_id,
        input_draft: prompt,
        input_draft_generation: coreState.input_draft_generation,
      });
      sendCommand(command);
      return true;
    },
    [
      coreState.active_project_id,
      coreState.active_session_id,
      coreState.input_draft_generation,
      coreState.is_running,
      coreState.pending_prompt,
      isManagementPending,
      isActiveModelReady,
      sendCommand,
    ],
  );

  const updateInputDraft = useCallback(
    (inputDraft: string) => {
      if (!coreState.active_project_id) return;
      const command = createCommand("input_draft_update", {
        project_id: coreState.active_project_id,
        session_id: coreState.active_session_id,
        input_draft: inputDraft,
      });
      dispatch({
        type: "input_draft_changed",
        request_id: command.request_id,
        project_id: command.payload.project_id,
        session_id: command.payload.session_id,
        input_draft: command.payload.input_draft,
      });
      sendCommand(command);
    },
    [
      coreState.active_project_id,
      coreState.active_session_id,
      sendCommand,
    ],
  );

  const createProject = useCallback(
    (name: string) => {
      sendManagementCommand(createCommand("project_create", { name }));
    },
    [sendManagementCommand],
  );

  const renameProject = useCallback(
    (projectId: string, name: string) => {
      sendManagementCommand(
        createCommand("project_update", { project_id: projectId, name }),
      );
    },
    [sendManagementCommand],
  );

  const deleteProject = useCallback(
    (projectId: string) => {
      sendManagementCommand(
        createCommand("project_delete", { project_id: projectId }),
      );
    },
    [sendManagementCommand],
  );

  const selectProject = useCallback(
    (projectId: string) => {
      sendManagementCommand(
        createCommand("project_select", { project_id: projectId }),
      );
    },
    [sendManagementCommand],
  );

  const importProject = useCallback(
    (name: string, files: WorkspaceTransferFile[]): Promise<void> => {
      const requests = workspaceTransferRequestsRef.current;
      if (!requests) {
        return Promise.reject(
          new Error("Workspace transfers are unavailable."),
        );
      }
      if (requests.size > 0) {
        return Promise.reject(
          new Error("Another workspace transfer is already in progress."),
        );
      }

      const command = createCommand("project_import", { name, files });
      const completion = requests.beginImport(command.request_id);
      try {
        const worker = workerRef.current;
        if (!worker) throw new Error("The browser core is not ready.");
        worker.postMessage(command);
      } catch (error) {
        requests.reject(command.request_id, toError(error));
      }
      return completion;
    },
    [],
  );

  const exportWorkspace = useCallback(
    (
      projectId: string,
      signal: AbortSignal,
    ): Promise<WorkspaceExportSnapshot> => {
      const requests = workspaceTransferRequestsRef.current;
      if (!requests) {
        return Promise.reject(
          new Error("Workspace transfers are unavailable."),
        );
      }
      return requestWorkspaceExport(
        requests,
        workerRef.current,
        projectId,
        signal,
      );
    },
    [],
  );

  const selectNewChat = useCallback(
    (projectId?: string) => {
      const targetProjectId = projectId ?? coreState.active_project_id;
      if (!targetProjectId) return;
      if (
        targetProjectId === coreState.active_project_id &&
        coreState.active_session_id === null
      ) {
        return;
      }
      sendManagementCommand(
        createCommand("new_chat", {
          project_id: targetProjectId,
        }),
      );
    },
    [
      coreState.active_project_id,
      coreState.active_session_id,
      sendManagementCommand,
    ],
  );

  const selectModel = useCallback(
    (providerId: string, modelId: string) => {
      if (!coreState.active_project_id) return;
      sendManagementCommand(
        createCommand("model_select", {
          project_id: coreState.active_project_id,
          session_id: coreState.active_session_id,
          provider_id: providerId,
          model_id: modelId,
        }),
      );
    },
    [
      coreState.active_project_id,
      coreState.active_session_id,
      sendManagementCommand,
    ],
  );

  const refreshProvider = useCallback(
    (providerId: string) => {
      if (
        [...pendingProviderRefreshRequestRef.current.values()].includes(
          providerId,
        )
      ) {
        return;
      }
      const command = createCommand("provider_refresh", {
        provider_id: providerId,
      });
      pendingProviderRefreshRequestRef.current.set(
        command.request_id,
        providerId,
      );
      setRefreshingProviderIds((current) => new Set(current).add(providerId));
      sendCommand(command);
    },
    [sendCommand],
  );

  const renameSession = useCallback(
    (projectId: string, sessionId: string, title: string) => {
      sendManagementCommand(
        createCommand("session_update", {
          project_id: projectId,
          session_id: sessionId,
          title,
        }),
      );
    },
    [sendManagementCommand],
  );

  const deleteSession = useCallback(
    (projectId: string, sessionId: string) => {
      sendManagementCommand(
        createCommand("session_delete", {
          project_id: projectId,
          session_id: sessionId,
        }),
      );
    },
    [sendManagementCommand],
  );

  const selectSession = useCallback(
    (projectId: string, sessionId: string) => {
      sendManagementCommand(
        createCommand("session_select", {
          project_id: projectId,
          session_id: sessionId,
        }),
      );
    },
    [sendManagementCommand],
  );

  const abortRun = useCallback(() => {
    if (!coreState.active_project_id || !coreState.active_session_id) return;
    sendCommand(
      createCommand("abort", {
        project_id: coreState.active_project_id,
        session_id: coreState.active_session_id,
      }),
    );
  }, [coreState.active_project_id, coreState.active_session_id, sendCommand]);

  const openFile = useCallback(
    (entry: FileEntry) => {
      if (!coreState.active_project_id) return;
      sendFileSystemCommand(
        createCommand(entry.kind === "directory" ? "fs_list" : "fs_read", {
          project_id: coreState.active_project_id,
          path: entry.path,
        }),
        {
          expected_workspace_revision: coreState.workspace_revision,
          request_kind: "navigation",
        },
      );
    },
    [
      coreState.active_project_id,
      coreState.workspace_revision,
      sendFileSystemCommand,
    ],
  );

  const navigateToParent = useCallback(() => {
    if (!coreState.active_project_id || coreState.current_path === "/") return;
    const segments = coreState.current_path.split("/").filter(Boolean);
    segments.pop();
    sendFileSystemCommand(
      createCommand("fs_list", {
        project_id: coreState.active_project_id,
        path: segments.length > 0 ? `/${segments.join("/")}` : "/",
      }),
      {
        expected_workspace_revision: coreState.workspace_revision,
        request_kind: "navigation",
      },
    );
  }, [
    coreState.active_project_id,
    coreState.current_path,
    coreState.workspace_revision,
    sendFileSystemCommand,
  ]);

  return {
    coreState,
    transportError,
    isManagementPending,
    isInputDraftPending,
    isActiveModelReady,
    refreshingProviderIds,
    submitPrompt,
    updateInputDraft,
    createProject,
    renameProject,
    deleteProject,
    selectProject,
    importProject,
    exportWorkspace,
    selectNewChat,
    selectModel,
    refreshProvider,
    renameSession,
    deleteSession,
    selectSession,
    abortRun,
    openFile,
    navigateToParent,
  };
}

export function cancelWorkspaceExportRequest(
  requests: WorkspaceTransferRequests,
  worker: Pick<Worker, "postMessage">,
  targetRequestId: string,
): boolean {
  if (!requests.cancelExport(targetRequestId)) return false;
  try {
    worker.postMessage(
      createCommand("workspace_export_cancel", {
        target_request_id: targetRequestId,
      }),
    );
  } catch {
    // The local request is already canceled; any eventual reply is ignored.
  }
  return true;
}

export function requestWorkspaceExport(
  requests: WorkspaceTransferRequests,
  worker: Pick<Worker, "postMessage"> | null,
  projectId: string,
  signal: AbortSignal,
): Promise<WorkspaceExportSnapshot> {
  if (signal.aborted) {
    return Promise.reject(
      new DOMException("The workspace export was canceled.", "AbortError"),
    );
  }
  if (requests.size > 0) {
    return Promise.reject(
      new Error("Another workspace transfer is already in progress."),
    );
  }
  if (!worker) {
    return Promise.reject(new Error("The browser core is not ready."));
  }

  const command = createCommand("workspace_export", {
    project_id: projectId,
  });
  const completion = requests.beginExport(command.request_id);
  try {
    worker.postMessage(command);
  } catch (error) {
    requests.reject(command.request_id, toError(error));
    return completion;
  }

  const cancelExport = () => {
    cancelWorkspaceExportRequest(
      requests,
      worker,
      command.request_id,
    );
  };
  signal.addEventListener("abort", cancelExport, { once: true });
  if (signal.aborted) cancelExport();

  return completion.finally(() => {
    signal.removeEventListener("abort", cancelExport);
  });
}

export function coreReducer(
  state: AgentSessionState,
  event: AgentSessionAction,
): AgentSessionState {
  switch (event.type) {
    case "input_draft_changed":
      if (!isActiveDraftScope(state, event)) return state;
      return {
        ...state,
        input_draft: event.input_draft,
        input_draft_generation: state.input_draft_generation + 1,
        pending_input_draft_request_id: event.request_id,
        input_draft_needs_sync: false,
        input_draft_retry_count: 0,
        error_message: null,
      };
    case "input_draft_sync_started":
      if (
        !isActiveDraftScope(state, event) ||
        (!state.input_draft_needs_sync &&
          state.input_draft_cleanup_scope === null) ||
        event.input_draft !== state.input_draft
      ) {
        return state;
      }
      return {
        ...state,
        pending_input_draft_request_id:
          event.request_id ?? state.pending_input_draft_request_id,
        input_draft_needs_sync: false,
        input_draft_cleanup_scope: null,
      };
    case "prompt_submitted":
      if (!isActiveDraftScope(state, event)) return state;
      return {
        ...state,
        pending_prompt: {
          request_id: event.request_id,
          project_id: event.project_id,
          session_id: event.session_id,
          input_draft: event.input_draft,
          input_draft_generation: event.input_draft_generation,
        },
        error_message: null,
      };
    case "fs_list_requested":
      return {
        ...state,
        pending_fs_list: toPendingFileSystemRequest(event),
        pending_fs_read: event.request_kind === "workspace_refresh"
          ? state.pending_fs_read
          : null,
        selected_file:
          event.request_kind === "workspace_refresh"
            ? state.selected_file
            : null,
        error_message: null,
      };
    case "fs_read_requested":
      return {
        ...state,
        pending_fs_list:
          state.pending_fs_list?.request_kind === "navigation"
            ? null
            : state.pending_fs_list,
        pending_fs_read: toPendingFileSystemRequest(event),
        selected_file:
          event.request_kind === "workspace_refresh"
            ? state.selected_file
            : null,
        error_message: null,
      };
    case "workspace_refresh_started":
      if (
        !state.pending_workspace_refresh ||
        state.pending_workspace_refresh.workspace_revision >
          event.workspace_revision
      ) {
        return state;
      }
      return { ...state, pending_workspace_refresh: null };
    case "transport_failed":
      return {
        ...state,
        core_lifecycle: "failed",
        core_status_message: event.message,
        is_ready: false,
        is_running: false,
        error_message: event.message,
        pending_input_draft_request_id: null,
        input_draft_needs_sync: false,
        input_draft_retry_count: 0,
        input_draft_cleanup_scope: null,
        pending_prompt: null,
        pending_fs_list: null,
        pending_fs_read: null,
        pending_workspace_refresh: null,
      };
    case "core_lifecycle":
      return {
        ...state,
        core_lifecycle: event.payload.phase,
        core_status_message: event.payload.status_message ?? null,
      };
    case "provider_catalog_snapshot":
      if (event.payload.catalog_revision < state.catalog_revision) return state;
      return {
        ...state,
        catalog_revision: event.payload.catalog_revision,
        providers: event.payload.providers,
      };
    case "ready":
      return applySnapshot(state, event.payload.state, event.request_id);
    case "state_snapshot":
      if (event.payload.state.state_revision < state.state_revision) return state;
      return applySnapshot(state, event.payload.state, event.request_id);
    case "run_state":
      return isActiveSessionEvent(state, event.payload)
        ? { ...state, is_running: event.payload.is_running }
        : state;
    case "timeline_entry_appended":
      if (!isActiveSessionEvent(state, event.payload)) return state;
      return acceptSubmittedPrompt(
        {
          ...state,
          error_message: null,
          timeline: appendTimelineEntry(
            state.timeline,
            event.payload.entry,
          ),
        },
        event.request_id,
        event.payload.entry.type === "user_message",
      );
    case "assistant_block_appended":
      return isActiveSessionEvent(state, event.payload)
        ? {
            ...state,
            timeline: appendAssistantBlock(
              state.timeline,
              event.payload.entry_id,
              event.payload.block,
            ),
          }
        : state;
    case "assistant_block_delta":
      return isActiveSessionEvent(state, event.payload)
        ? {
            ...state,
            timeline: appendAssistantBlockDelta(
              state.timeline,
              event.payload.entry_id,
              event.payload.block_id,
              event.payload.block_type,
              event.payload.text_delta,
            ),
          }
        : state;
    case "timeline_entry_updated":
      return isActiveSessionEvent(state, event.payload)
        ? {
            ...state,
            timeline: updateTimelineEntry(
              state.timeline,
              event.payload.entry,
            ),
          }
        : state;
    case "assistant_block_updated":
      return isActiveSessionEvent(state, event.payload)
        ? {
            ...state,
            timeline: updateAssistantBlock(
              state.timeline,
              event.payload.entry_id,
              event.payload.block,
            ),
          }
        : state;
    case "workspace_changed": {
      if (
        !isActiveSessionEvent(state, event.payload) ||
        event.payload.workspace_revision <= state.workspace_revision
      ) {
        return state;
      }
      const inFlightRefreshPath =
        state.pending_fs_read?.request_kind === "workspace_refresh" &&
        state.pending_fs_read.expected_workspace_revision <
          event.payload.workspace_revision
          ? state.pending_fs_read.path
          : null;
      const changedPaths = appendChangedPath(
        appendPath(
          state.pending_workspace_refresh?.changed_paths ?? [],
          inFlightRefreshPath,
        ),
        event.payload.change,
      );
      return {
        ...state,
        workspace_revision: event.payload.workspace_revision,
        pending_fs_list: invalidateStaleFileSystemRequest(
          state.pending_fs_list,
          event.payload.workspace_revision,
        ),
        pending_fs_read: invalidateStaleFileSystemRequest(
          state.pending_fs_read,
          event.payload.workspace_revision,
        ),
        pending_workspace_refresh: {
          workspace_revision: event.payload.workspace_revision,
          changed_paths: changedPaths,
        },
      };
    }
    case "workspace_export_snapshot":
      return state;
    case "files_snapshot": {
      const pending = state.pending_fs_list;
      if (
        event.payload.project_id !== state.active_project_id ||
        event.request_id !== pending?.request_id ||
        event.payload.path !== pending.path
      ) {
        return state;
      }
      if (
        event.payload.workspace_revision < state.workspace_revision ||
        event.payload.workspace_revision <
          pending.expected_workspace_revision
      ) {
        return { ...state, pending_fs_list: null };
      }
      return {
        ...state,
        workspace_revision: event.payload.workspace_revision,
        current_path: event.payload.path,
        files: event.payload.files,
        selected_file: pending.request_kind === "workspace_refresh"
          ? state.selected_file
          : null,
        pending_fs_list: null,
      };
    }
    case "file_content": {
      const pending = state.pending_fs_read;
      if (
        event.payload.project_id !== state.active_project_id ||
        event.request_id !== pending?.request_id ||
        event.payload.path !== pending.path
      ) {
        return state;
      }
      if (
        event.payload.workspace_revision < state.workspace_revision ||
        event.payload.workspace_revision <
          pending.expected_workspace_revision
      ) {
        return { ...state, pending_fs_read: null };
      }
      return {
        ...state,
        workspace_revision: event.payload.workspace_revision,
        selected_file: {
          path: event.payload.path,
          content: event.payload.content,
        },
        pending_fs_read: null,
      };
    }
    case "input_draft_saved":
      if (
        !isActiveDraftScope(state, event.payload) ||
        event.request_id !== state.pending_input_draft_request_id ||
        event.payload.input_draft !== state.input_draft
      ) {
        return state;
      }
      return {
        ...state,
        pending_input_draft_request_id: null,
        input_draft_retry_count: 0,
        error_message: null,
      };
    case "error": {
      let nextState =
        event.request_id === state.pending_prompt?.request_id
          ? { ...state, pending_prompt: null }
          : state;
      if (
        event.payload.code === "persistence_failed" &&
        event.request_id === state.pending_input_draft_request_id
      ) {
        nextState = {
          ...nextState,
          pending_input_draft_request_id: null,
          input_draft_needs_sync: true,
          input_draft_retry_count: state.input_draft_retry_count + 1,
        };
      }
      if (
        (event.payload.code === "fs_list_failed" &&
          event.request_id !== nextState.pending_fs_list?.request_id) ||
        (event.payload.code === "fs_read_failed" &&
          event.request_id !== nextState.pending_fs_read?.request_id)
      ) {
        return nextState;
      }
      if (
        (event.payload.project_id !== undefined &&
          event.payload.project_id !== nextState.active_project_id) ||
        (event.payload.session_id !== undefined &&
          event.payload.session_id !== nextState.active_session_id)
      ) {
        return nextState;
      }
      return {
        ...nextState,
        error_message: event.payload.message,
        pending_fs_list:
          event.payload.code === "fs_list_failed"
            ? null
            : nextState.pending_fs_list,
        pending_fs_read:
          event.payload.code === "fs_read_failed"
            ? null
            : nextState.pending_fs_read,
      };
    }
  }
}

function applySnapshot(
  state: AgentSessionState,
  snapshot: CoreStateSnapshot,
  requestId?: string,
): AgentSessionState {
  const preserveWorkspace =
    state.is_ready &&
    state.active_project_id === snapshot.active_project_id &&
    snapshot.workspace_revision <= state.workspace_revision;
  const scopeChanged =
    state.active_project_id !== snapshot.active_project_id ||
    state.active_session_id !== snapshot.active_session_id;
  const acceptedVirtualPrompt =
    requestId !== undefined &&
    requestId === state.pending_prompt?.request_id &&
    state.pending_prompt.project_id === snapshot.active_project_id &&
    state.pending_prompt.session_id === null &&
    snapshot.active_session_id !== null;
  const draftChangedAfterSubmit =
    acceptedVirtualPrompt &&
    (state.input_draft_generation !==
      state.pending_prompt?.input_draft_generation ||
      state.input_draft !== state.pending_prompt?.input_draft);
  const draftEditedAfterSubmit =
    acceptedVirtualPrompt &&
    state.input_draft_generation !==
      state.pending_prompt?.input_draft_generation;
  const preserveDraft =
    draftChangedAfterSubmit ||
    (!scopeChanged &&
      (state.pending_input_draft_request_id !== null ||
        state.input_draft_needs_sync ||
        state.pending_prompt !== null));
  return {
    ...state,
    state_revision: snapshot.state_revision,
    catalog_revision: Math.max(
      state.catalog_revision,
      snapshot.catalog_revision,
    ),
    workspace_revision: preserveWorkspace
      ? Math.max(state.workspace_revision, snapshot.workspace_revision)
      : snapshot.workspace_revision,
    projects: snapshot.projects,
    sessions: snapshot.sessions,
    providers:
      snapshot.catalog_revision >= state.catalog_revision
        ? snapshot.providers
        : state.providers,
    active_model: snapshot.active_model,
    active_project_id: snapshot.active_project_id,
    active_session_id: snapshot.active_session_id,
    input_draft: preserveDraft ? state.input_draft : snapshot.input_draft,
    input_draft_generation:
      scopeChanged && !draftChangedAfterSubmit
        ? 0
        : state.input_draft_generation,
    pending_input_draft_request_id: scopeChanged
      ? null
      : state.pending_input_draft_request_id,
    input_draft_needs_sync:
      (draftChangedAfterSubmit && state.input_draft.length > 0) ||
      (!scopeChanged && state.input_draft_needs_sync),
    input_draft_retry_count: scopeChanged
      ? 0
      : state.input_draft_retry_count,
    input_draft_cleanup_scope:
      draftEditedAfterSubmit && state.input_draft.length > 0
        ? {
            project_id: snapshot.active_project_id,
            session_id: null,
          }
        : scopeChanged
          ? null
          : state.input_draft_cleanup_scope,
    pending_prompt:
      acceptedVirtualPrompt || scopeChanged ? null : state.pending_prompt,
    timeline: snapshot.timeline,
    files: preserveWorkspace ? state.files : snapshot.files,
    current_path: preserveWorkspace ? state.current_path : "/",
    selected_file: preserveWorkspace ? state.selected_file : null,
    core_lifecycle: "ready",
    core_status_message: null,
    is_ready: true,
    is_running: snapshot.is_running,
    error_message: null,
    pending_fs_list: preserveWorkspace
      ? invalidateStaleFileSystemRequest(
          state.pending_fs_list,
          snapshot.workspace_revision,
        )
      : null,
    pending_fs_read: preserveWorkspace
      ? invalidateStaleFileSystemRequest(
          state.pending_fs_read,
          snapshot.workspace_revision,
        )
      : null,
    pending_workspace_refresh: preserveWorkspace
      ? state.pending_workspace_refresh
      : null,
  };
}

function acceptSubmittedPrompt(
  state: AgentSessionState,
  requestId: string | undefined,
  isUserMessage: boolean,
): AgentSessionState {
  const pendingPrompt = state.pending_prompt;
  if (
    !isUserMessage ||
    requestId === undefined ||
    requestId !== pendingPrompt?.request_id
  ) {
    return state;
  }
  const draftIsUnchanged =
    state.input_draft_generation === pendingPrompt.input_draft_generation &&
    state.input_draft === pendingPrompt.input_draft;
  return {
    ...state,
    input_draft: draftIsUnchanged ? "" : state.input_draft,
    pending_input_draft_request_id: draftIsUnchanged
      ? null
      : state.pending_input_draft_request_id,
    input_draft_needs_sync: false,
    input_draft_retry_count: draftIsUnchanged
      ? 0
      : state.input_draft_retry_count,
    pending_prompt: null,
  };
}

function isActiveSessionEvent(
  state: AgentSessionState,
  scope: { project_id: string; session_id: string },
): boolean {
  return (
    scope.project_id === state.active_project_id &&
    scope.session_id === state.active_session_id
  );
}

function isActiveDraftScope(
  state: AgentSessionState,
  scope: { project_id: string; session_id: string | null },
): boolean {
  return (
    scope.project_id === state.active_project_id &&
    scope.session_id === state.active_session_id
  );
}

function toPendingFileSystemRequest(
  request: PendingFileSystemRequest,
): PendingFileSystemRequest {
  return {
    request_id: request.request_id,
    path: request.path,
    expected_workspace_revision: request.expected_workspace_revision,
    request_kind: request.request_kind,
  };
}

function invalidateStaleFileSystemRequest(
  request: PendingFileSystemRequest | null,
  workspaceRevision: number,
): PendingFileSystemRequest | null {
  return request &&
    request.expected_workspace_revision >= workspaceRevision
    ? request
    : null;
}

function appendChangedPath(
  paths: string[],
  change: WorkspaceChangeSummary,
): string[] {
  return appendPath(paths, change.path);
}

function appendPath(paths: string[], path: string | null): string[] {
  return path === null || paths.includes(path) ? paths : [...paths, path];
}

function appendTimelineEntry(
  timeline: TimelineEntry[],
  entry: TimelineEntry,
): TimelineEntry[] {
  const exists = timeline.some(
    (candidate) => candidate.entry_id === entry.entry_id,
  );
  return exists ? timeline : [...timeline, entry];
}

function updateTimelineEntry(
  timeline: TimelineEntry[],
  entry: TimelineEntry,
): TimelineEntry[] {
  const existingIndex = timeline.findIndex(
    (candidate) => candidate.entry_id === entry.entry_id,
  );
  return existingIndex === -1
    ? timeline
    : replaceAt(timeline, existingIndex, entry);
}

function appendAssistantBlock(
  timeline: TimelineEntry[],
  entryId: string,
  block: AssistantBlock,
): TimelineEntry[] {
  return updateAssistantEntry(timeline, entryId, (entry) => {
    const exists = entry.blocks.some(
      (candidate) => candidate.block_id === block.block_id,
    );
    if (exists) return entry;
    return {
      ...entry,
      blocks: [...entry.blocks, block],
    };
  });
}

function appendAssistantBlockDelta(
  timeline: TimelineEntry[],
  entryId: string,
  blockId: string,
  blockType: "assistant_text" | "reasoning",
  textDelta: string,
): TimelineEntry[] {
  return updateAssistantEntry(timeline, entryId, (entry) => {
    const blockIndex = entry.blocks.findIndex(
      (candidate) =>
        candidate.block_id === blockId && candidate.type === blockType,
    );
    if (blockIndex === -1) return entry;

    const block = entry.blocks[blockIndex];
    if (block.type !== "assistant_text" && block.type !== "reasoning") {
      return entry;
    }
    return {
      ...entry,
      blocks: replaceAt(entry.blocks, blockIndex, {
        ...block,
        text: block.text + textDelta,
      }),
    };
  });
}

function updateAssistantBlock(
  timeline: TimelineEntry[],
  entryId: string,
  block: AssistantBlock,
): TimelineEntry[] {
  return updateAssistantEntry(timeline, entryId, (entry) => {
    const blockIndex = entry.blocks.findIndex(
      (candidate) => candidate.block_id === block.block_id,
    );
    return blockIndex === -1
      ? entry
      : {
          ...entry,
          blocks: replaceAt(entry.blocks, blockIndex, block),
        };
  });
}

function updateAssistantEntry(
  timeline: TimelineEntry[],
  entryId: string,
  update: (
    entry: Extract<TimelineEntry, { type: "assistant_message" }>,
  ) => Extract<TimelineEntry, { type: "assistant_message" }>,
): TimelineEntry[] {
  const entryIndex = timeline.findIndex(
    (candidate) =>
      candidate.entry_id === entryId &&
      candidate.type === "assistant_message",
  );
  if (entryIndex === -1) return timeline;

  const entry = timeline[entryIndex];
  if (entry.type !== "assistant_message") return timeline;
  const updatedEntry = update(entry);
  return updatedEntry === entry
    ? timeline
    : replaceAt(timeline, entryIndex, updatedEntry);
}

function replaceAt<T>(values: T[], index: number, value: T): T[] {
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  );
}

function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("The workspace transfer could not be started.");
}

export function createWorkerTerminator(
  worker: Pick<Worker, "onmessage" | "onerror" | "terminate">,
): () => void {
  let isTerminated = false;
  return () => {
    if (isTerminated) return;
    isTerminated = true;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  };
}
