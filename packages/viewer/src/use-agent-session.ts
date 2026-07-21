import {
  createCommand,
  parseCoreEvent,
  type ChatMessage,
  type CoreEvent,
  type FileEntry,
  type ToolActivity,
  type ViewerCommand,
} from "@researchbox/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

export type AgentSessionState = {
  session_id: string | null;
  messages: ChatMessage[];
  files: FileEntry[];
  current_path: string;
  selected_file: { path: string; content: string } | null;
  activities: ToolActivity[];
  is_ready: boolean;
  is_running: boolean;
  error_message: string | null;
};

const initialState: AgentSessionState = {
  session_id: null,
  messages: [],
  files: [],
  current_path: "/",
  selected_file: null,
  activities: [],
  is_ready: false,
  is_running: false,
  error_message: null,
};

export function useAgentSession(createWorker: () => Worker) {
  const [coreState, dispatch] = useReducer(coreReducer, initialState);
  const [transportError, setTransportError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const sendCommand = useCallback((command: ViewerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

  useEffect(() => {
    const worker = createWorker();
    workerRef.current = worker;
    worker.onmessage = (message: MessageEvent<unknown>) => {
      try {
        dispatch(parseCoreEvent(message.data));
      } catch {
        setTransportError("The browser core sent an invalid event.");
      }
    };
    worker.onerror = () => {
      setTransportError("The browser core could not start. Refresh to try again.");
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
      if (!text || !coreState.session_id || coreState.is_running) return false;
      sendCommand(
        createCommand("prompt", {
          session_id: coreState.session_id,
          text,
        }),
      );
      return true;
    },
    [coreState.is_running, coreState.session_id, sendCommand],
  );

  const startNewChat = useCallback(() => {
    if (!coreState.session_id) return;
    sendCommand(
      createCommand("session_reset", { session_id: coreState.session_id }),
    );
  }, [coreState.session_id, sendCommand]);

  const abortRun = useCallback(() => {
    if (!coreState.session_id) return;
    sendCommand(createCommand("abort", { session_id: coreState.session_id }));
  }, [coreState.session_id, sendCommand]);

  const openFile = useCallback(
    (entry: FileEntry) => {
      sendCommand(
        createCommand(entry.kind === "directory" ? "fs_list" : "fs_read", {
          path: entry.path,
        }),
      );
    },
    [sendCommand],
  );

  const navigateToParent = useCallback(() => {
    if (coreState.current_path === "/") return;
    const segments = coreState.current_path.split("/").filter(Boolean);
    segments.pop();
    sendCommand(
      createCommand("fs_list", {
        path: segments.length > 0 ? `/${segments.join("/")}` : "/",
      }),
    );
  }, [coreState.current_path, sendCommand]);

  return {
    coreState,
    transportError,
    submitPrompt,
    startNewChat,
    abortRun,
    openFile,
    navigateToParent,
  };
}

function coreReducer(
  state: AgentSessionState,
  event: CoreEvent,
): AgentSessionState {
  switch (event.type) {
    case "ready":
      return {
        ...state,
        session_id: event.payload.session_id,
        messages: event.payload.messages,
        files: event.payload.files,
        is_ready: true,
      };
    case "run_state":
      return { ...state, is_running: event.payload.is_running };
    case "message_added":
      return {
        ...state,
        error_message: null,
        messages: [...state.messages, event.payload.message],
      };
    case "message_delta":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === event.payload.message_id
            ? { ...message, content: message.content + event.payload.text_delta }
            : message,
        ),
      };
    case "message_finished":
      return {
        ...state,
        error_message: event.payload.error_message ?? state.error_message,
        messages: state.messages.map((message) =>
          message.id === event.payload.message_id
            ? { ...message, status: event.payload.status }
            : message,
        ),
      };
    case "tool_activity": {
      const exists = state.activities.some(
        (activity) =>
          activity.tool_call_id === event.payload.activity.tool_call_id,
      );
      return {
        ...state,
        activities: exists
          ? state.activities.map((activity) =>
              activity.tool_call_id === event.payload.activity.tool_call_id
                ? event.payload.activity
                : activity,
            )
          : [...state.activities, event.payload.activity],
      };
    }
    case "files_snapshot":
      return {
        ...state,
        current_path: event.payload.path,
        files: event.payload.files,
        selected_file: null,
      };
    case "file_content":
      return { ...state, selected_file: event.payload };
    case "session_reset":
      return {
        ...state,
        messages: [],
        activities: [],
        is_running: false,
        error_message: null,
      };
    case "error":
      return { ...state, error_message: event.payload.message };
  }
}
