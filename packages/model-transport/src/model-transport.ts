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

export function parseModelRequest(value: unknown): ModelRequest {
  if (!isRecord(value)) throw new Error("Model request must be an object.");

  const sessionId = requireString(value, "session_id");
  const prompt = requireString(value, "prompt").trim();
  if (!prompt) throw new Error("prompt must be a non-empty string.");
  if (!Array.isArray(value.tool_results)) {
    throw new Error("tool_results must be an array.");
  }

  const toolResults = value.tool_results.map((result): ModelToolResult => {
    if (!isRecord(result)) throw new Error("Tool result must be an object.");
    const toolName = parseToolName(result.tool_name);
    if (typeof result.is_error !== "boolean") {
      throw new Error("is_error must be a boolean.");
    }
    return {
      tool_call_id: requireString(result, "tool_call_id"),
      tool_name: toolName,
      content: requireString(result, "content", true),
      is_error: result.is_error,
    };
  });

  return {
    session_id: sessionId,
    prompt,
    tool_results: toolResults,
  };
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
      return {
        type: "tool_call",
        tool_call_id: requireString(value, "tool_call_id"),
        tool_name: parseToolName(value.tool_name),
        arguments: { path: requireString(value.arguments, "path") },
      };
    }
    case "done":
      return { type: "done" };
    default:
      throw new Error(`Unknown model event type: ${value.type}`);
  }
}

function parseToolName(value: unknown): ModelToolName {
  if (value !== "list_files" && value !== "read_file") {
    throw new Error(`Unsupported tool: ${String(value)}`);
  }
  return value;
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
