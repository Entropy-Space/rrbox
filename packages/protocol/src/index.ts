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

export function parseCoreEvent(value: unknown): CoreEvent {
  if (!isRecord(value)) throw new Error("Core event must be an object.");
  if (value.protocol_version !== PROTOCOL_VERSION) {
    throw new Error("Unsupported protocol version.");
  }

  const eventId = requireString(value, "event_id");
  const requestId =
    value.request_id === undefined
      ? undefined
      : requireString(value, "request_id");
  if (typeof value.type !== "string" || !isRecord(value.payload)) {
    throw new Error("Core event type and payload are required.");
  }

  switch (value.type) {
    case "ready":
      return eventEnvelope(
        "ready",
        eventId,
        {
          session_id: requireString(value.payload, "session_id"),
          messages: requireArray(value.payload, "messages").map(parseChatMessage),
          files: requireArray(value.payload, "files").map(parseFileEntry),
        },
        requestId,
      );
    case "run_state":
      return eventEnvelope(
        "run_state",
        eventId,
        { is_running: requireBoolean(value.payload, "is_running") },
        requestId,
      );
    case "message_added":
      return eventEnvelope(
        "message_added",
        eventId,
        { message: parseChatMessage(value.payload.message) },
        requestId,
      );
    case "message_delta":
      return eventEnvelope(
        "message_delta",
        eventId,
        {
          message_id: requireString(value.payload, "message_id"),
          text_delta: requireString(value.payload, "text_delta", true),
        },
        requestId,
      );
    case "message_finished": {
      const status = value.payload.status;
      if (status !== "complete" && status !== "aborted" && status !== "error") {
        throw new Error("Invalid finished message status.");
      }
      const errorMessage =
        value.payload.error_message === undefined
          ? undefined
          : requireString(value.payload, "error_message", true);
      return eventEnvelope(
        "message_finished",
        eventId,
        {
          message_id: requireString(value.payload, "message_id"),
          status,
          ...(errorMessage === undefined
            ? {}
            : { error_message: errorMessage }),
        },
        requestId,
      );
    }
    case "tool_activity":
      return eventEnvelope(
        "tool_activity",
        eventId,
        { activity: parseToolActivity(value.payload.activity) },
        requestId,
      );
    case "files_snapshot":
      return eventEnvelope(
        "files_snapshot",
        eventId,
        {
          path: requireString(value.payload, "path"),
          files: requireArray(value.payload, "files").map(parseFileEntry),
        },
        requestId,
      );
    case "file_content":
      return eventEnvelope(
        "file_content",
        eventId,
        {
          path: requireString(value.payload, "path"),
          content: requireString(value.payload, "content", true),
        },
        requestId,
      );
    case "session_reset":
      return eventEnvelope(
        "session_reset",
        eventId,
        { session_id: requireString(value.payload, "session_id") },
        requestId,
      );
    case "error":
      return eventEnvelope(
        "error",
        eventId,
        {
          code: requireString(value.payload, "code"),
          message: requireString(value.payload, "message"),
        },
        requestId,
      );
    default:
      throw new Error(`Unknown core event type: ${value.type}`);
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

function eventEnvelope<T extends CoreEvent["type"]>(
  type: T,
  eventId: string,
  payload: Extract<CoreEvent, { type: T }>["payload"],
  requestId?: string,
): Extract<CoreEvent, { type: T }> {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: eventId,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    type,
    payload,
  } as Extract<CoreEvent, { type: T }>;
}

function parseChatMessage(value: unknown): ChatMessage {
  if (!isRecord(value)) throw new Error("Chat message must be an object.");
  const role = value.role;
  const status = value.status;
  if (role !== "user" && role !== "assistant") {
    throw new Error("Invalid chat message role.");
  }
  if (
    status !== "streaming" &&
    status !== "complete" &&
    status !== "aborted" &&
    status !== "error"
  ) {
    throw new Error("Invalid chat message status.");
  }
  return {
    id: requireString(value, "id"),
    role,
    content: requireString(value, "content", true),
    created_at: requireString(value, "created_at"),
    status,
  };
}

function parseFileEntry(value: unknown): FileEntry {
  if (!isRecord(value)) throw new Error("File entry must be an object.");
  if (value.kind !== "file" && value.kind !== "directory") {
    throw new Error("Invalid file entry kind.");
  }
  const size = value.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    throw new Error("File entry size must be a non-negative number.");
  }
  return {
    name: requireString(value, "name"),
    path: requireString(value, "path"),
    kind: value.kind,
    size,
  };
}

function parseToolActivity(value: unknown): ToolActivity {
  if (!isRecord(value)) throw new Error("Tool activity must be an object.");
  const status = value.status;
  if (status !== "running" && status !== "complete" && status !== "error") {
    throw new Error("Invalid tool activity status.");
  }
  const summary =
    value.summary === undefined
      ? undefined
      : requireString(value, "summary", true);
  return {
    tool_call_id: requireString(value, "tool_call_id"),
    tool_name: requireString(value, "tool_name"),
    label: requireString(value, "label"),
    status,
    ...(summary === undefined ? {} : { summary }),
  };
}

function requireArray(
  value: Record<string, unknown>,
  field: string,
): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) throw new Error(`${field} must be an array.`);
  return candidate;
}

function requireBoolean(
  value: Record<string, unknown>,
  field: string,
): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return candidate;
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  allowEmpty = false,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    (!allowEmpty && candidate.length === 0)
  ) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
