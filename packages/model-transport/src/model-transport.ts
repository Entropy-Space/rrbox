export type ModelToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "replace_text";

type ModelToolCallEnvelope<TName extends ModelToolName, TArguments> = {
  tool_call_id: string;
  tool_name: TName;
  arguments: TArguments;
};

export type ModelToolCall =
  | ModelToolCallEnvelope<
      "list_files" | "read_file",
      { path: string }
    >
  | ModelToolCallEnvelope<
      "write_file",
      { path: string; content: string }
    >
  | ModelToolCallEnvelope<
      "replace_text",
      { path: string; old_text: string; new_text: string }
    >;

export type ModelToolResult = {
  tool_call_id: string;
  tool_name: ModelToolName;
  content: string;
  is_error: boolean;
};

export type ModelToolDefinition = {
  name: ModelToolName;
  description: string;
  parameters: unknown;
};

export type ModelConversationMessage =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      tool_calls: ModelToolCall[];
    }
  | ({ role: "tool" } & ModelToolResult);

export type ModelDescriptor = {
  provider_id: string;
  provider_display_name: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_tools: boolean;
  supports_reasoning: boolean;
};

export type ModelStreamEvent =
  | { type: "text_delta"; text_delta: string }
  | ({ type: "tool_call" } & ModelToolCall)
  | {
      type: "done";
      stop_reason?: "stop" | "length" | "tool_use";
    };

export type ModelRequest = {
  session_id: string;
  provider_id: string;
  model_id: string;
  system_prompt: string;
  messages: ModelConversationMessage[];
  tools: ModelToolDefinition[];
};

export interface ModelTransport {
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>;
}

export interface ModelCatalogTransport extends ModelTransport {
  listModels(signal: AbortSignal): Promise<ModelDescriptor[]>;
}

export function parseModelRequest(value: unknown): ModelRequest {
  if (!isRecord(value)) throw new Error("Model request must be an object.");

  if (!Array.isArray(value.messages)) {
    throw new Error("messages must be an array.");
  }
  if (!Array.isArray(value.tools)) {
    throw new Error("tools must be an array.");
  }

  return {
    session_id: requireIdentifier(value, "session_id"),
    provider_id: requireIdentifier(value, "provider_id"),
    model_id: requireIdentifier(value, "model_id"),
    system_prompt: requireString(value, "system_prompt", true),
    messages: value.messages.map(parseConversationMessage),
    tools: value.tools.map(parseToolDefinition),
  };
}

export function parseModelDescriptor(value: unknown): ModelDescriptor {
  if (!isRecord(value)) throw new Error("Model descriptor must be an object.");

  return {
    provider_id: requireIdentifier(value, "provider_id"),
    provider_display_name: requireString(value, "provider_display_name"),
    model_id: requireIdentifier(value, "model_id"),
    display_name: requireString(value, "display_name"),
    context_window: requireNullablePositiveInteger(value, "context_window"),
    max_output_tokens: requireNullablePositiveInteger(
      value,
      "max_output_tokens",
    ),
    supports_tools: requireBoolean(value, "supports_tools"),
    supports_reasoning: requireBoolean(value, "supports_reasoning"),
  };
}

export function parseModelDescriptors(value: unknown): ModelDescriptor[] {
  if (!Array.isArray(value)) {
    throw new Error("Model descriptors must be an array.");
  }
  return value.map(parseModelDescriptor);
}

export function parseModelStreamEvent(value: unknown): ModelStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Model event must be an object with a type.");
  }

  switch (value.type) {
    case "text_delta":
      return {
        type: "text_delta",
        text_delta: requireString(value, "text_delta", true),
      };
    case "tool_call":
      return { type: "tool_call", ...parseModelToolCall(value) };
    case "done": {
      const stopReason = value.stop_reason;
      if (
        stopReason !== undefined &&
        stopReason !== "stop" &&
        stopReason !== "length" &&
        stopReason !== "tool_use"
      ) {
        throw new Error("Invalid model stop_reason.");
      }
      return {
        type: "done",
        ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      };
    }
    default:
      throw new Error(`Unknown model event type: ${value.type}`);
  }
}

function parseConversationMessage(value: unknown): ModelConversationMessage {
  if (!isRecord(value)) {
    throw new Error("Conversation message must be an object.");
  }

  switch (value.role) {
    case "user":
      return {
        role: "user",
        content: requireString(value, "content", true),
      };
    case "assistant": {
      if (!Array.isArray(value.tool_calls)) {
        throw new Error("Assistant message tool_calls must be an array.");
      }
      const content = requireString(value, "content", true);
      const toolCalls = value.tool_calls.map(parseModelToolCall);
      if (!content && toolCalls.length === 0) {
        throw new Error(
          "Assistant message must contain text or at least one tool call.",
        );
      }
      return {
        role: "assistant",
        content,
        tool_calls: toolCalls,
      };
    }
    case "tool":
      return {
        role: "tool",
        ...parseToolResult(value),
      };
    default:
      throw new Error(`Unsupported conversation role: ${String(value.role)}`);
  }
}

export function parseModelToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value)) throw new Error("Tool call must be an object.");
  if (!isRecord(value.arguments)) {
    throw new Error("Tool call arguments must be an object.");
  }
  const toolCallId = requireIdentifier(value, "tool_call_id");
  const toolName = requireModelToolName(value.tool_name);
  const path = requireString(value.arguments, "path");

  switch (toolName) {
    case "list_files":
    case "read_file":
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: { path },
      };
    case "write_file":
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: {
          path,
          content: requireString(value.arguments, "content", true),
        },
      };
    case "replace_text":
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: {
          path,
          old_text: requireString(value.arguments, "old_text", true),
          new_text: requireString(value.arguments, "new_text", true),
        },
      };
  }
}

function parseToolResult(value: unknown): ModelToolResult {
  if (!isRecord(value)) throw new Error("Tool result must be an object.");
  return {
    tool_call_id: requireIdentifier(value, "tool_call_id"),
    tool_name: requireModelToolName(value.tool_name),
    content: requireString(value, "content", true),
    is_error: requireBoolean(value, "is_error"),
  };
}

function parseToolDefinition(value: unknown): ModelToolDefinition {
  if (!isRecord(value)) throw new Error("Tool definition must be an object.");
  if (!("parameters" in value)) {
    throw new Error("Tool definition parameters are required.");
  }
  return {
    name: requireModelToolName(value.name),
    description: requireString(value, "description", true),
    parameters: value.parameters,
  };
}

export function isModelToolName(value: unknown): value is ModelToolName {
  return (
    value === "list_files" ||
    value === "read_file" ||
    value === "write_file" ||
    value === "replace_text"
  );
}

function requireModelToolName(value: unknown): ModelToolName {
  if (!isModelToolName(value)) {
    throw new Error(`Unsupported tool: ${String(value)}`);
  }
  return value;
}

function requireIdentifier(
  value: Record<string, unknown>,
  field: string,
): string {
  const candidate = requireString(value, field);
  if (!candidate.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
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
    throw new Error(`${field} must be a string.`);
  }
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

function requireNullablePositiveInteger(
  value: Record<string, unknown>,
  field: string,
): number | null {
  const candidate = value[field];
  if (candidate === null) return null;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate <= 0
  ) {
    throw new Error(`${field} must be a positive integer or null.`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
