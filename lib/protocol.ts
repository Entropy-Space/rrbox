export const PROTOCOL_VERSION = 1 as const;

export type MessageRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  status: "streaming" | "complete" | "aborted" | "error";
};

export type FileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
};

export type ToolActivity = {
  tool_call_id: string;
  tool_name: string;
  label: string;
  status: "running" | "complete" | "error";
  summary?: string;
};

type CommandEnvelope<TType extends string, TPayload extends object> = {
  protocol_version: typeof PROTOCOL_VERSION;
  request_id: string;
  type: TType;
  payload: TPayload;
};

export type ViewerCommand =
  | CommandEnvelope<"bootstrap", Record<string, never>>
  | CommandEnvelope<"prompt", { session_id: string; text: string }>
  | CommandEnvelope<"abort", { session_id: string }>
  | CommandEnvelope<"session_reset", { session_id: string }>
  | CommandEnvelope<"fs_list", { path: string }>
  | CommandEnvelope<"fs_read", { path: string }>;

type EventEnvelope<TType extends string, TPayload extends object> = {
  protocol_version: typeof PROTOCOL_VERSION;
  event_id: string;
  request_id?: string;
  type: TType;
  payload: TPayload;
};

export type CoreEvent =
  | EventEnvelope<
      "ready",
      {
        session_id: string;
        messages: ChatMessage[];
        files: FileEntry[];
      }
    >
  | EventEnvelope<"run_state", { is_running: boolean }>
  | EventEnvelope<"message_added", { message: ChatMessage }>
  | EventEnvelope<
      "message_delta",
      { message_id: string; text_delta: string }
    >
  | EventEnvelope<
      "message_finished",
      {
        message_id: string;
        status: "complete" | "aborted" | "error";
        error_message?: string;
      }
    >
  | EventEnvelope<"tool_activity", { activity: ToolActivity }>
  | EventEnvelope<"files_snapshot", { path: string; files: FileEntry[] }>
  | EventEnvelope<"file_content", { path: string; content: string }>
  | EventEnvelope<"session_reset", { session_id: string }>
  | EventEnvelope<"error", { code: string; message: string }>;

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function createCommand<T extends ViewerCommand["type"]>(
  type: T,
  payload: Extract<ViewerCommand, { type: T }>["payload"],
): Extract<ViewerCommand, { type: T }> {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: createRequestId(),
    type,
    payload,
  } as Extract<ViewerCommand, { type: T }>;
}

export function parseViewerCommand(value: unknown): ViewerCommand {
  if (!isRecord(value)) throw new Error("Command must be an object.");
  if (value.protocol_version !== PROTOCOL_VERSION) {
    throw new Error("Unsupported protocol version.");
  }
  if (typeof value.request_id !== "string" || !value.request_id) {
    throw new Error("Command request_id must be a non-empty string.");
  }
  if (typeof value.type !== "string" || !isRecord(value.payload)) {
    throw new Error("Command type and payload are required.");
  }

  const requestId = value.request_id;
  switch (value.type) {
    case "bootstrap":
      return envelope("bootstrap", requestId, {});
    case "prompt":
      return envelope("prompt", requestId, {
        session_id: requireString(value.payload, "session_id"),
        text: requireString(value.payload, "text"),
      });
    case "abort":
      return envelope("abort", requestId, {
        session_id: requireString(value.payload, "session_id"),
      });
    case "session_reset":
      return envelope("session_reset", requestId, {
        session_id: requireString(value.payload, "session_id"),
      });
    case "fs_list":
      return envelope("fs_list", requestId, {
        path: requireString(value.payload, "path"),
      });
    case "fs_read":
      return envelope("fs_read", requestId, {
        path: requireString(value.payload, "path"),
      });
    default:
      throw new Error(`Unknown command type: ${value.type}`);
  }
}

function envelope<T extends ViewerCommand["type"]>(
  type: T,
  requestId: string,
  payload: Extract<ViewerCommand, { type: T }>["payload"],
): Extract<ViewerCommand, { type: T }> {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    type,
    payload,
  } as Extract<ViewerCommand, { type: T }>;
}

function requireString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
