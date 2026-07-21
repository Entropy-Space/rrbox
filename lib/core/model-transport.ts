export type ModelToolName = "list_files" | "read_file";

export type ModelToolCall = {
  tool_call_id: string;
  tool_name: ModelToolName;
  arguments: { path: string };
};

export type ModelToolResult = {
  tool_call_id: string;
  tool_name: ModelToolName;
  content: string;
  is_error: boolean;
};

export type ModelStreamEvent =
  | { type: "text_delta"; text_delta: string }
  | ({ type: "tool_call" } & ModelToolCall)
  | { type: "done" };

export type ModelRequest = {
  session_id: string;
  prompt: string;
  tool_results: ModelToolResult[];
};

export interface ModelTransport {
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>;
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
    case "tool_call": {
      if (!isRecord(value.arguments)) {
        throw new Error("Tool call arguments must be an object.");
      }
      const toolName = requireString(value, "tool_name");
      if (toolName !== "list_files" && toolName !== "read_file") {
        throw new Error(`Unsupported tool: ${toolName}`);
      }
      return {
        type: "tool_call",
        tool_call_id: requireString(value, "tool_call_id"),
        tool_name: toolName,
        arguments: { path: requireString(value.arguments, "path") },
      };
    }
    case "done":
      return { type: "done" };
    default:
      throw new Error(`Unknown model event type: ${value.type}`);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
