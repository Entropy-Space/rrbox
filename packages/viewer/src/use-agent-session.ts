import {
  createCommand,
  parseCoreEvent,
  type ChatMessage,
  type CoreEvent,
  type CoreStateSnapshot,
  type FileEntry,
  type ProjectSummary,
  type SessionSummary,
  type ToolActivity,
  type ViewerCommand,
} from "@researchbox/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

export type AgentSessionState = {
  state_revision: number;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  active_project_id: string | null;
  active_session_id: string | null;
  messages: ChatMessage[];
  files: FileEntry[];
  current_path: string;
  selected_file: { path: string; content: string } | null;
  activities: ToolActivity[];
  is_ready: boolean;
  is_running: boolean;
  error_message: string | null;
  pending_fs_list_request_id: string | null;
  pending_fs_read_request_id: string | null;
};

export const initialAgentSessionState: AgentSessionState = {
  state_revision: 0,
  projects: [],
  sessions: [],
  active_project_id: null,
  active_session_id: null,
  messages: [],
  files: [],
  current_path: "/",
  selected_file: null,
  activities: [],
  is_ready: false,
  is_running: false,
  error_message: null,
  pending_fs_list_request_id: null,
  pending_fs_read_request_id: null,
};

type AgentSessionAction =
  | CoreEvent
  | { type: "fs_list_requested"; request_id: string }
  | { type: "fs_read_requested"; request_id: string };

type ManagementCommand = Exclude<
  ViewerCommand,
  { type: "bootstrap" | "prompt" | "abort" | "fs_list" | "fs_read" }
>;

export function useAgentSession(createWorker: () => Worker) {
  const [coreState, dispatch] = useReducer(
    coreReducer,
    initialAgentSessionState,
  );
  const [transportError, setTransportError] = useState<string | null>(null);
  const [isManagementPending, setManagementPending] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const pendingManagementRequestRef = useRef<string | null>(null);

  const sendCommand = useCallback((command: ViewerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

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
    ) => {
      dispatch({
        type:
          command.type === "fs_list"
            ? "fs_list_requested"
            : "fs_read_requested",
        request_id: command.request_id,
      });
      sendCommand(command);
    },
    [sendCommand],
  );

  useEffect(() => {
    const worker = createWorker();
    workerRef.current = worker;
    worker.onmessage = (message: MessageEvent<unknown>) => {
      try {
        const event = parseCoreEvent(message.data);
        dispatch(event);
        if (
          event.request_id === pendingManagementRequestRef.current &&
          (event.type === "state_snapshot" || event.type === "error")
        ) {
          pendingManagementRequestRef.current = null;
          setManagementPending(false);
        }
      } catch {
        setTransportError("The browser core sent an invalid event.");
      }
    };
    worker.onerror = () => {
      setTransportError("The browser core could not start. Refresh to try again.");
      pendingManagementRequestRef.current = null;
      setManagementPending(false);
    };
    worker.postMessage(createCommand("bootstrap", {}));

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [createWorker]);

  const submitPrompt = useCallback(
    (prompt: string): boolean => {
      const text = prompt.trim();
      if (
        !text ||
        !coreState.active_project_id ||
        !coreState.active_session_id ||
        coreState.is_running ||
        isManagementPending
      ) {
        return false;
      }
      sendCommand(
        createCommand("prompt", {
          project_id: coreState.active_project_id,
          session_id: coreState.active_session_id,
          text,
        }),
      );
      return true;
    },
    [
      coreState.active_project_id,
      coreState.active_session_id,
      coreState.is_running,
      isManagementPending,
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

  const createSession = useCallback(
    (projectId?: string, title?: string) => {
      const targetProjectId = projectId ?? coreState.active_project_id;
      if (!targetProjectId) return;
      sendManagementCommand(
        createCommand("session_create", {
          project_id: targetProjectId,
          ...(title === undefined ? {} : { title }),
        }),
      );
    },
    [coreState.active_project_id, sendManagementCommand],
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
      );
    },
    [coreState.active_project_id, sendFileSystemCommand],
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
    );
  }, [
    coreState.active_project_id,
    coreState.current_path,
    sendFileSystemCommand,
  ]);

  return {
    coreState,
    transportError,
    isManagementPending,
    submitPrompt,
    createProject,
    renameProject,
    deleteProject,
    selectProject,
    createSession,
    renameSession,
    deleteSession,
    selectSession,
    abortRun,
    openFile,
    navigateToParent,
  };
}

export function coreReducer(
  state: AgentSessionState,
  event: AgentSessionAction,
): AgentSessionState {
  switch (event.type) {
    case "fs_list_requested":
      return {
        ...state,
        pending_fs_list_request_id: event.request_id,
        pending_fs_read_request_id: null,
        selected_file: null,
        error_message: null,
      };
    case "fs_read_requested":
      return {
        ...state,
        pending_fs_list_request_id: null,
        pending_fs_read_request_id: event.request_id,
        selected_file: null,
        error_message: null,
      };
    case "ready":
      return applySnapshot(state, event.payload.state);
    case "state_snapshot":
      if (event.payload.state.state_revision < state.state_revision) return state;
      return applySnapshot(state, event.payload.state);
    case "run_state":
      return isActiveSessionEvent(state, event.payload)
        ? { ...state, is_running: event.payload.is_running }
        : state;
    case "message_added":
      return isActiveSessionEvent(state, event.payload)
        ? {
            ...state,
            error_message: null,
            messages: [...state.messages, event.payload.message],
          }
        : state;
    case "message_delta":
      return isActiveSessionEvent(state, event.payload)
        ? {
            ...state,
            messages: state.messages.map((message) =>
              message.id === event.payload.message_id
                ? {
                    ...message,
                    content: message.content + event.payload.text_delta,
                  }
                : message,
            ),
          }
        : state;
    case "message_finished":
      return isActiveSessionEvent(state, event.payload)
        ? {
            ...state,
            error_message: event.payload.error_message ?? state.error_message,
            messages: state.messages.map((message) =>
              message.id === event.payload.message_id
                ? { ...message, status: event.payload.status }
                : message,
            ),
          }
        : state;
    case "tool_activity":
      if (!isActiveSessionEvent(state, event.payload)) return state;
      return {
        ...state,
        activities: upsertActivity(state.activities, event.payload.activity),
      };
    case "files_snapshot":
      if (
        event.payload.project_id !== state.active_project_id ||
        event.request_id !== state.pending_fs_list_request_id
      ) {
        return state;
      }
      return {
        ...state,
        current_path: event.payload.path,
        files: event.payload.files,
        selected_file: null,
        pending_fs_list_request_id: null,
      };
    case "file_content":
      return event.payload.project_id === state.active_project_id &&
        event.request_id === state.pending_fs_read_request_id
        ? {
            ...state,
            selected_file: {
              path: event.payload.path,
              content: event.payload.content,
            },
            pending_fs_read_request_id: null,
          }
        : state;
    case "error":
      if (
        (event.payload.code === "fs_list_failed" &&
          event.request_id !== state.pending_fs_list_request_id) ||
        (event.payload.code === "fs_read_failed" &&
          event.request_id !== state.pending_fs_read_request_id)
      ) {
        return state;
      }
      if (
        (event.payload.project_id !== undefined &&
          event.payload.project_id !== state.active_project_id) ||
        (event.payload.session_id !== undefined &&
          event.payload.session_id !== state.active_session_id)
      ) {
        return state;
      }
      return {
        ...state,
        error_message: event.payload.message,
        pending_fs_list_request_id:
          event.payload.code === "fs_list_failed"
            ? null
            : state.pending_fs_list_request_id,
        pending_fs_read_request_id:
          event.payload.code === "fs_read_failed"
            ? null
            : state.pending_fs_read_request_id,
      };
  }
}

function applySnapshot(
  state: AgentSessionState,
  snapshot: CoreStateSnapshot,
): AgentSessionState {
  const preserveWorkspace =
    state.is_ready && state.active_project_id === snapshot.active_project_id;
  return {
    ...state,
    state_revision: snapshot.state_revision,
    projects: snapshot.projects,
    sessions: snapshot.sessions,
    active_project_id: snapshot.active_project_id,
    active_session_id: snapshot.active_session_id,
    messages: snapshot.messages,
    activities: snapshot.activities,
    files: preserveWorkspace ? state.files : snapshot.files,
    current_path: preserveWorkspace ? state.current_path : "/",
    selected_file: preserveWorkspace ? state.selected_file : null,
    is_ready: true,
    is_running: snapshot.is_running,
    error_message: null,
    pending_fs_list_request_id: preserveWorkspace
      ? state.pending_fs_list_request_id
      : null,
    pending_fs_read_request_id: preserveWorkspace
      ? state.pending_fs_read_request_id
      : null,
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

function upsertActivity(
  activities: ToolActivity[],
  activity: ToolActivity,
): ToolActivity[] {
  const exists = activities.some(
    (candidate) => candidate.tool_call_id === activity.tool_call_id,
  );
  return exists
    ? activities.map((candidate) =>
        candidate.tool_call_id === activity.tool_call_id ? activity : candidate,
      )
    : [...activities, activity];
}
