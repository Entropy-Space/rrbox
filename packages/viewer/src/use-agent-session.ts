import type {
  CoreTransport,
  CoreTransportFactory,
  CoreTransportFailure,
} from "@researchbox/client";
import {
  createCommand,
  type AssistantBlock,
  type BootstrapSelection,
  type CoreEvent,
  type CoreLifecyclePhase,
  type CoreStateSnapshot,
  type FileEntry,
  type ModelSelection,
  type ProjectSummary,
  type ProviderSummary,
  type SessionSummary,
  type SummaryReviewRequest,
  type SummaryReviewResolution,
  type TimelineEntry,
  type ViewerCommand,
  type WorkspaceRecoveryNotice,
  type WorkspaceTransferFile,
} from "@researchbox/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  WorkspaceChangeRequests,
  type WorkspaceChangeRevertResult,
  type WorkspaceChangeSnapshot,
} from "./workspace-change.ts";
import {
  WorkspaceTransferRequests,
  type WorkspaceExportSnapshot,
} from "./workspace-transfer.ts";

const SESSION_SELECTION_STORAGE_KEY = "researchbox:session-selection:v1";

export type SummaryReviewView = SummaryReviewRequest & {
  project_id: string;
  session_id: string;
  is_submitting: boolean;
  error_message: string | null;
};

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
  deleted_file_preview_intent: DeletedFilePreviewIntent | null;
  core_lifecycle: CoreLifecyclePhase;
  core_status_message: string | null;
  workspace_recovery_notice: WorkspaceRecoveryNotice | null;
  is_ready: boolean;
  is_running: boolean;
  error_message: string | null;
  input_draft_error_message: string | null;
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
  deleted_file_preview_intent: null,
  core_lifecycle: "electing",
  core_status_message: null,
  workspace_recovery_notice: null,
  is_ready: false,
  is_running: false,
  error_message: null,
  input_draft_error_message: null,
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
  reopen_path?: string;
};

type DeletedFilePreviewIntent = {
  path: string;
  change_id: string;
  phase: "deleted" | "reopening";
};

type WorkspaceMutationEffect =
  | "content_changed"
  | "file_deleted"
  | "created_file_reverted"
  | "deleted_file_reverted";

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
      | "workspace_export_cancel"
      | "workspace_change_read"
      | "workspace_change_revert";
  }
>;

export function useAgentSession(
  createTransport: CoreTransportFactory,
  transport_lifecycle_key: unknown = null,
) {
  const [coreState, dispatch] = useReducer(
    coreReducer,
    initialAgentSessionState,
  );
  const [transportError, setTransportError] = useState<string | null>(null);
  const [isManagementPending, setManagementPending] = useState(false);
  const [refreshingProviderIds, setRefreshingProviderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [summaryReview, setSummaryReview] =
    useState<SummaryReviewView | null>(null);
  const [isSummaryReviewVisible, setSummaryReviewVisible] =
    useState(false);
  const transportRef = useRef<CoreTransport | null>(null);
  const pendingManagementRequestRef = useRef<string | null>(null);
  const pendingProviderRefreshRequestRef = useRef(new Map<string, string>());
  const pendingSummaryReviewResolutionRef = useRef<{
    request_id: string;
    interaction_id: string;
  } | null>(null);
  const workspaceTransferRequestsRef =
    useRef<WorkspaceTransferRequests | null>(null);
  if (workspaceTransferRequestsRef.current === null) {
    workspaceTransferRequestsRef.current = new WorkspaceTransferRequests();
  }
  const workspaceChangeRequestsRef =
    useRef<WorkspaceChangeRequests | null>(null);
  if (workspaceChangeRequestsRef.current === null) {
    workspaceChangeRequestsRef.current = new WorkspaceChangeRequests();
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
    transportRef.current?.send(command);
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

    const selectedPath = workspaceRefreshReadPath(
      refresh.reopen_path,
      coreState.selected_file?.path,
    );
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
    const transport = createTransport();
    const closeTransport = createTransportCloser(transport);
    const failTransport = (message: string) => {
      closeTransport();
      if (transportRef.current === transport) transportRef.current = null;
      setTransportError(message);
      dispatch({ type: "transport_failed", message });
      pendingManagementRequestRef.current = null;
      pendingProviderRefreshRequestRef.current.clear();
      pendingSummaryReviewResolutionRef.current = null;
      setSummaryReview(null);
      setSummaryReviewVisible(false);
      workspaceTransferRequestsRef.current?.rejectAll(new Error(message));
      workspaceChangeRequestsRef.current?.rejectAll(new Error(message));
      setRefreshingProviderIds(new Set());
      setManagementPending(false);
    };
    transportRef.current = transport;
    const unsubscribe = transport.subscribe(
      (event) => {
        try {
          setTransportError(null);
          if (event.type === "summary_review_requested") {
            setSummaryReview({
              ...structuredClone(event.payload),
              is_submitting: false,
              error_message: null,
            });
            setSummaryReviewVisible(true);
          } else if (event.type === "summary_review_updated") {
            setSummaryReview((current) =>
              current?.interaction_id === event.payload.interaction_id
                ? {
                    ...structuredClone(event.payload),
                    is_submitting: current.is_submitting,
                    error_message: current.error_message,
                  }
                : current
            );
          } else if (event.type === "summary_review_resolved") {
            pendingSummaryReviewResolutionRef.current = null;
            const closesDialog =
              event.payload.decision === "approve" ||
              event.payload.decision === "raw" ||
              event.payload.decision === "dismiss" ||
              event.payload.decision === "cancel";
            if (closesDialog) setSummaryReviewVisible(false);
            setSummaryReview((current) =>
              current?.interaction_id === event.payload.interaction_id
                ? closesDialog
                  ? null
                  : {
                      ...current,
                      is_submitting: false,
                      error_message: null,
                    }
                : current
            );
          } else if (
            event.type === "run_state" &&
            !event.payload.is_running
          ) {
            pendingSummaryReviewResolutionRef.current = null;
            setSummaryReviewVisible(false);
            setSummaryReview((current) =>
              current?.project_id === event.payload.project_id &&
                current.session_id === event.payload.session_id
                ? null
                : current
            );
          } else if (
            event.type === "error" &&
            event.request_id ===
              pendingSummaryReviewResolutionRef.current?.request_id
          ) {
            pendingSummaryReviewResolutionRef.current = null;
            setSummaryReview((current) =>
              current
                ? {
                    ...current,
                    is_submitting: false,
                    error_message: event.payload.message,
                  }
                : current
            );
          }
          const handledWorkspaceTransfer =
            workspaceTransferRequestsRef.current?.accept(event) ?? false;
          const handledWorkspaceChange =
            workspaceChangeRequestsRef.current?.accept(event) ?? false;
          if (
            (!handledWorkspaceTransfer && !handledWorkspaceChange) ||
            event.type === "state_snapshot" ||
            event.type === "workspace_change_reverted"
          ) {
            dispatch(event);
          }
          if (event.type === "state_snapshot") {
            saveSessionSelection(event.payload.state);
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
            if (
              event.type === "error" ||
              provider?.availability !== "loading"
            ) {
              pendingProviderRefreshRequestRef.current.delete(
                refreshRequestId,
              );
              setRefreshingProviderIds((current) => {
                const next = new Set(current);
                next.delete(refreshingProviderId);
                return next;
              });
            }
          }
        } catch {
          failTransport("The browser core sent an invalid event.");
        }
      },
      (failure) => {
        failTransport(coreTransportFailureMessage(failure));
      },
    );
    try {
      transport.send(createCommand("bootstrap", loadSessionSelection()));
    } catch {
      failTransport("The browser core stopped. Refresh to try again.");
    }

    return () => {
      unsubscribe();
      workspaceTransferRequestsRef.current?.rejectAll(
        new Error(
          "The browser core closed before the workspace transfer completed.",
        ),
      );
      workspaceChangeRequestsRef.current?.rejectAll(
        new Error(
          "The browser core closed before the workspace change request completed.",
        ),
      );
      closeTransport();
      if (transportRef.current === transport) transportRef.current = null;
      pendingSummaryReviewResolutionRef.current = null;
      setSummaryReview(null);
      setSummaryReviewVisible(false);
    };
  }, [createTransport, transport_lifecycle_key]);

  const submitPrompt = useCallback(
    (prompt: string): boolean => {
      const text = prompt.trim();
      if (
        !text ||
        !coreState.is_ready ||
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
      coreState.is_ready,
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
        const transport = transportRef.current;
        if (!transport) throw new Error("The browser core is not ready.");
        transport.send(command);
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
        transportRef.current,
        projectId,
        signal,
      );
    },
    [],
  );

  const readWorkspaceChange = useCallback(
    (
      projectId: string,
      changeId: string,
    ): Promise<WorkspaceChangeSnapshot> =>
      requestWorkspaceChange(
        workspaceChangeRequestsRef.current,
        transportRef.current,
        "workspace_change_read",
        projectId,
        changeId,
      ),
    [],
  );

  const revertWorkspaceChange = useCallback(
    (
      projectId: string,
      changeId: string,
    ): Promise<WorkspaceChangeRevertResult> =>
      requestWorkspaceChange(
        workspaceChangeRequestsRef.current,
        transportRef.current,
        "workspace_change_revert",
        projectId,
        changeId,
      ),
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

  const resolveSummaryReview = useCallback(
    (resolution: SummaryReviewResolution): void => {
      const review = summaryReview;
      if (!review || review.is_submitting) return;
      const command = createCommand("summary_review_resolve", {
        project_id: review.project_id,
        session_id: review.session_id,
        interaction_id: review.interaction_id,
        resolution,
      });
      const transport = transportRef.current;
      if (!transport) {
        setSummaryReview({
          ...review,
          error_message: "The browser core is not ready.",
        });
        return;
      }
      pendingSummaryReviewResolutionRef.current = {
        request_id: command.request_id,
        interaction_id: review.interaction_id,
      };
      setSummaryReview({
        ...review,
        is_submitting: true,
        error_message: null,
      });
      try {
        transport.send(command);
      } catch (error) {
        pendingSummaryReviewResolutionRef.current = null;
        setSummaryReview({
          ...review,
          is_submitting: false,
          error_message: error instanceof Error
            ? error.message
            : "The summary review could not be submitted.",
        });
      }
    },
    [summaryReview],
  );

  const touchSummaryReview = useCallback((): void => {
    const review = summaryReview;
    if (!review || review.is_submitting) return;
    const transport = transportRef.current;
    if (!transport) return;
    try {
      transport.send(createCommand("summary_review_touch", {
        project_id: review.project_id,
        session_id: review.session_id,
        interaction_id: review.interaction_id,
      }));
    } catch {
      // Activity heartbeats are best-effort and never change review state.
    }
  }, [summaryReview]);

  const setSummaryReviewVisibility = useCallback(
    (isVisible: boolean): void => {
      const review = summaryReview;
      if (!review || review.is_submitting) return;
      setSummaryReviewVisible(isVisible);
      const transport = transportRef.current;
      if (!transport) return;
      try {
        transport.send(createCommand("summary_review_visibility", {
          project_id: review.project_id,
          session_id: review.session_id,
          interaction_id: review.interaction_id,
          is_visible: isVisible,
        }));
      } catch {
        // Visibility is local-first; run completion clears stale reviews.
      }
    },
    [summaryReview],
  );
  const dismissSummaryReview = useCallback(
    () => setSummaryReviewVisibility(false),
    [setSummaryReviewVisibility],
  );
  const reopenSummaryReview = useCallback(
    () => setSummaryReviewVisibility(true),
    [setSummaryReviewVisibility],
  );

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
    summaryReview,
    isSummaryReviewVisible,
    resolveSummaryReview,
    touchSummaryReview,
    dismissSummaryReview,
    reopenSummaryReview,
    submitPrompt,
    updateInputDraft,
    createProject,
    renameProject,
    deleteProject,
    selectProject,
    importProject,
    exportWorkspace,
    readWorkspaceChange,
    revertWorkspaceChange,
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

function loadSessionSelection(): BootstrapSelection {
  try {
    const serialized = window.sessionStorage.getItem(
      SESSION_SELECTION_STORAGE_KEY,
    );
    if (serialized === null) return {};
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== "object" || value === null) return {};
    const selection = value as Record<string, unknown>;
    if (
      typeof selection.active_project_id !== "string" ||
      selection.active_project_id.length === 0 ||
      !(
        selection.active_session_id === null ||
        (typeof selection.active_session_id === "string" &&
          selection.active_session_id.length > 0)
      )
    ) {
      return {};
    }
    return {
      active_project_id: selection.active_project_id,
      active_session_id: selection.active_session_id,
    };
  } catch {
    return {};
  }
}

function saveSessionSelection(state: CoreStateSnapshot): void {
  try {
    window.sessionStorage.setItem(
      SESSION_SELECTION_STORAGE_KEY,
      JSON.stringify({
        active_project_id: state.active_project_id,
        active_session_id: state.active_session_id,
      } satisfies Required<BootstrapSelection>),
    );
  } catch {
    // Session storage is optional in restricted or ephemeral browser contexts.
  }
}

function requestWorkspaceChange(
  requests: WorkspaceChangeRequests | null,
  transport: Pick<CoreTransport, "send"> | null,
  type: "workspace_change_read",
  projectId: string,
  changeId: string,
): Promise<WorkspaceChangeSnapshot>;
function requestWorkspaceChange(
  requests: WorkspaceChangeRequests | null,
  transport: Pick<CoreTransport, "send"> | null,
  type: "workspace_change_revert",
  projectId: string,
  changeId: string,
): Promise<WorkspaceChangeRevertResult>;
function requestWorkspaceChange(
  requests: WorkspaceChangeRequests | null,
  transport: Pick<CoreTransport, "send"> | null,
  type: "workspace_change_read" | "workspace_change_revert",
  projectId: string,
  changeId: string,
): Promise<WorkspaceChangeSnapshot | WorkspaceChangeRevertResult> {
  if (!requests) {
    return Promise.reject(
      new Error("Workspace change inspection is unavailable."),
    );
  }
  if (!transport) {
    return Promise.reject(new Error("The browser core is not ready."));
  }

  if (type === "workspace_change_read") {
    const command = createCommand(type, {
      project_id: projectId,
      change_id: changeId,
    });
    return postWorkspaceChangeRequest(
      requests,
      transport,
      command,
      requests.beginRead(
        command.request_id,
        command.payload.project_id,
        command.payload.change_id,
      ),
    );
  }

  const command = createCommand(type, {
    project_id: projectId,
    change_id: changeId,
  });
  return postWorkspaceChangeRequest(
    requests,
    transport,
    command,
    requests.beginRevert(
      command.request_id,
      command.payload.project_id,
      command.payload.change_id,
    ),
  );
}

function postWorkspaceChangeRequest<T>(
  requests: WorkspaceChangeRequests,
  transport: Pick<CoreTransport, "send">,
  command: Extract<
    ViewerCommand,
    { type: "workspace_change_read" | "workspace_change_revert" }
  >,
  completion: Promise<T>,
): Promise<T> {
  try {
    transport.send(command);
  } catch (error) {
    requests.reject(command.request_id, toError(error));
  }
  return completion;
}

export function cancelWorkspaceExportRequest(
  requests: WorkspaceTransferRequests,
  transport: Pick<CoreTransport, "send">,
  targetRequestId: string,
): boolean {
  if (!requests.cancelExport(targetRequestId)) return false;
  try {
    transport.send(
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
  transport: Pick<CoreTransport, "send"> | null,
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
  if (!transport) {
    return Promise.reject(new Error("The browser core is not ready."));
  }

  const command = createCommand("workspace_export", {
    project_id: projectId,
  });
  const completion = requests.beginExport(command.request_id);
  try {
    transport.send(command);
  } catch (error) {
    requests.reject(command.request_id, toError(error));
    return completion;
  }

  const cancelExport = () => {
    cancelWorkspaceExportRequest(
      requests,
      transport,
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
        input_draft_error_message: null,
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
        deleted_file_preview_intent:
          event.request_kind === "workspace_refresh"
            ? state.deleted_file_preview_intent
            : null,
        pending_workspace_refresh:
          event.request_kind === "workspace_refresh"
            ? state.pending_workspace_refresh
            : clearWorkspaceRefreshReopenPath(
                state.pending_workspace_refresh,
              ),
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
        deleted_file_preview_intent:
          event.request_kind === "workspace_refresh" ||
            state.deleted_file_preview_intent?.path === event.path
            ? state.deleted_file_preview_intent
            : null,
        pending_workspace_refresh:
          event.request_kind === "workspace_refresh" ||
            state.pending_workspace_refresh?.reopen_path === event.path
            ? state.pending_workspace_refresh
            : clearWorkspaceRefreshReopenPath(
                state.pending_workspace_refresh,
              ),
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
        input_draft_error_message: null,
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
    case "workspace_recovery_notice":
      return {
        ...state,
        workspace_recovery_notice: { ...event.payload },
      };
    case "workspace_recovery_cleared":
      return {
        ...state,
        workspace_recovery_notice: null,
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
      if (!isActiveSessionEvent(state, event.payload)) return state;
      return applyWorkspaceMutation(
        state,
        event.payload.workspace_revision,
        event.payload.change.path,
        event.payload.change.change_id,
        event.payload.change.change_kind === "deleted"
          ? "file_deleted"
          : "content_changed",
      );
    }
    case "workspace_export_snapshot":
    case "workspace_change_snapshot":
    case "summary_review_requested":
    case "summary_review_updated":
    case "summary_review_resolved":
      return state;
    case "workspace_change_reverted":
      if (
        event.payload.project_id !== state.active_project_id ||
        event.payload.revert_outcome === "already_reverted"
      ) {
        return state;
      }
      return applyWorkspaceMutation(
        state,
        event.payload.workspace_revision,
        event.payload.path,
        event.payload.change_id,
        event.payload.change_kind === "created"
          ? "created_file_reverted"
          : event.payload.change_kind === "deleted"
            ? "deleted_file_reverted"
            : "content_changed",
      );
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
        deleted_file_preview_intent:
          state.deleted_file_preview_intent?.path === event.payload.path
            ? null
            : state.deleted_file_preview_intent,
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
        input_draft_error_message: null,
      };
    case "error": {
      const isInputDraftPersistenceFailure =
        event.payload.code === "persistence_failed" &&
        event.request_id === state.pending_input_draft_request_id;
      let nextState =
        event.request_id === state.pending_prompt?.request_id
          ? { ...state, pending_prompt: null }
          : state;
      if (isInputDraftPersistenceFailure) {
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
        error_message: isInputDraftPersistenceFailure
          ? nextState.error_message
          : event.payload.message,
        input_draft_error_message: isInputDraftPersistenceFailure
          ? event.payload.message
          : nextState.input_draft_error_message,
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
    deleted_file_preview_intent: preserveWorkspace
      ? state.deleted_file_preview_intent
      : null,
    core_lifecycle: "ready",
    core_status_message: null,
    is_ready: true,
    is_running: snapshot.is_running,
    error_message: null,
    input_draft_error_message: scopeChanged
      ? null
      : state.input_draft_error_message,
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

function applyWorkspaceMutation(
  state: AgentSessionState,
  workspaceRevision: number,
  changedPath: string,
  changeId: string,
  effect: WorkspaceMutationEffect,
): AgentSessionState {
  if (workspaceRevision <= state.workspace_revision) return state;
  const inFlightPreviewPath =
    state.pending_fs_read &&
    state.pending_fs_read.expected_workspace_revision < workspaceRevision
      ? state.pending_fs_read.path
      : null;
  const removesChangedFile =
    effect === "file_deleted" ||
    effect === "created_file_reverted";
  const deletedPreviewIntent = state.deleted_file_preview_intent;
  const shouldReopenDeletedFile =
    effect === "deleted_file_reverted" &&
    deletedPreviewIntent?.path === changedPath &&
    deletedPreviewIntent.change_id === changeId;
  let reopenPath =
    state.pending_workspace_refresh?.reopen_path ??
    (inFlightPreviewPath !== null && state.selected_file === null
      ? inFlightPreviewPath
      : deletedPreviewIntent?.phase === "reopening"
        ? deletedPreviewIntent.path
        : null);
  const previewTargetWasDeleted =
    effect === "file_deleted" &&
    (state.selected_file?.path === changedPath ||
      reopenPath === changedPath ||
      (deletedPreviewIntent?.phase === "reopening" &&
        deletedPreviewIntent.path === changedPath));
  if (shouldReopenDeletedFile) reopenPath = changedPath;
  if (removesChangedFile && reopenPath === changedPath) {
    reopenPath = null;
  }
  const changedPaths = appendPath(
    appendPath(
      appendPath(
        state.pending_workspace_refresh?.changed_paths ?? [],
        reopenPath,
      ),
      inFlightPreviewPath,
    ),
    changedPath,
  );
  const invalidatesDeletedPreviewIntent =
    deletedPreviewIntent?.path === changedPath &&
    (
      effect === "created_file_reverted" ||
      effect === "deleted_file_reverted" ||
      (effect === "content_changed" &&
        deletedPreviewIntent.phase === "deleted") ||
      (effect === "file_deleted" && !previewTargetWasDeleted)
    );
  return {
    ...state,
    workspace_revision: workspaceRevision,
    selected_file:
      removesChangedFile && state.selected_file?.path === changedPath
        ? null
        : state.selected_file,
    deleted_file_preview_intent: previewTargetWasDeleted
      ? {
          path: changedPath,
          change_id: changeId,
          phase: "deleted",
        }
      : shouldReopenDeletedFile
        ? {
            path: changedPath,
            change_id: changeId,
            phase: "reopening",
          }
        : invalidatesDeletedPreviewIntent
          ? null
          : deletedPreviewIntent,
    pending_fs_list: invalidateStaleFileSystemRequest(
      state.pending_fs_list,
      workspaceRevision,
    ),
    pending_fs_read: invalidateStaleFileSystemRequest(
      state.pending_fs_read,
      workspaceRevision,
    ),
    pending_workspace_refresh: {
      workspace_revision: workspaceRevision,
      changed_paths: changedPaths,
      ...(reopenPath === null ? {} : { reopen_path: reopenPath }),
    },
  };
}

function appendPath(paths: string[], path: string | null): string[] {
  return path === null || paths.includes(path) ? paths : [...paths, path];
}

function clearWorkspaceRefreshReopenPath(
  refresh: PendingWorkspaceRefresh | null,
): PendingWorkspaceRefresh | null {
  if (refresh?.reopen_path === undefined) return refresh;
  return {
    workspace_revision: refresh.workspace_revision,
    changed_paths: refresh.changed_paths,
  };
}

export function workspaceRefreshReadPath(
  reopenPath: string | undefined,
  selectedPath: string | undefined,
): string | null {
  return reopenPath ?? selectedPath ?? null;
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

function coreTransportFailureMessage(
  failure: CoreTransportFailure,
): string {
  return failure === "invalid_event"
    ? "The browser core sent an invalid event."
    : "The browser core stopped. Refresh to try again.";
}

export function createTransportCloser(
  transport: Pick<CoreTransport, "close">,
): () => void {
  let isClosed = false;
  return () => {
    if (isClosed) return;
    isClosed = true;
    transport.close();
  };
}
