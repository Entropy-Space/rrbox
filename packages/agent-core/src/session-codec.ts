import type {
  AgentMessage,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

export function encodeAgentMessages(messages: AgentMessage[]): unknown[] {
  return messages.map((message) => encodeMessage(requireStandardMessage(message)));
}

export function decodeAgentMessages(values: unknown[]): AgentMessage[] {
  return values.map(decodeMessage);
}

function requireStandardMessage(message: AgentMessage): Message {
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") {
    throw new Error("Agent message role is not supported by the transcript codec.");
  }
  return message as Message;
}

function encodeMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") {
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map(encodeContent),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool_result",
      tool_call_id: message.toolCallId,
      tool_name: message.toolName,
      content: message.content.map(encodeContent),
      is_error: message.isError,
      timestamp: message.timestamp,
    };
  }
  return {
    role: "assistant",
    content: message.content.map(encodeContent),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel === undefined
      ? {}
      : { response_model: message.responseModel }),
    ...(message.responseId === undefined
      ? {}
      : { response_id: message.responseId }),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cache_read: message.usage.cacheRead,
      cache_write: message.usage.cacheWrite,
      total_tokens: message.usage.totalTokens,
      cost: {
        input: message.usage.cost.input,
        output: message.usage.cost.output,
        cache_read: message.usage.cost.cacheRead,
        cache_write: message.usage.cost.cacheWrite,
        total: message.usage.cost.total,
      },
    },
    stop_reason: message.stopReason,
    ...(message.errorMessage === undefined
      ? {}
      : { error_message: message.errorMessage }),
    timestamp: message.timestamp,
  };
}

function encodeContent(
  content: TextContent | ImageContent | ThinkingContent | ToolCall,
): Record<string, unknown> {
  switch (content.type) {
    case "text":
      return {
        type: "text",
        text: content.text,
        ...(content.textSignature === undefined
          ? {}
          : { text_signature: content.textSignature }),
      };
    case "image":
      return {
        type: "image",
        data: content.data,
        mime_type: content.mimeType,
      };
    case "thinking":
      return {
        type: "thinking",
        thinking: content.thinking,
        ...(content.thinkingSignature === undefined
          ? {}
          : { thinking_signature: content.thinkingSignature }),
        ...(content.redacted === undefined
          ? {}
          : { redacted: content.redacted }),
      };
    case "toolCall":
      return {
        type: "tool_call",
        id: content.id,
        name: content.name,
        arguments: structuredClone(content.arguments),
        ...(content.thoughtSignature === undefined
          ? {}
          : { thought_signature: content.thoughtSignature }),
      };
  }
}

function decodeMessage(value: unknown): AgentMessage {
  const message = requireRecord(value, "Stored agent message");
  switch (message.role) {
    case "user":
      return decodeUserMessage(message);
    case "assistant":
      return decodeAssistantMessage(message);
    case "tool_result":
      return decodeToolResultMessage(message);
    default:
      throw new Error("Stored agent message role is invalid.");
  }
}

function decodeUserMessage(message: Record<string, unknown>): UserMessage {
  const content = message.content;
  return {
    role: "user",
    content:
      typeof content === "string"
        ? content
        : requireArray(message, "content").map((value) => {
            const decoded = decodeContent(value);
            if (decoded.type === "thinking" || decoded.type === "toolCall") {
              throw new Error("Stored user content block is invalid.");
            }
            return decoded;
          }),
    timestamp: requireNumber(message, "timestamp"),
  };
}

function decodeAssistantMessage(
  message: Record<string, unknown>,
): AssistantMessage {
  const usage = requireRecord(message.usage, "Stored usage");
  const cost = requireRecord(usage.cost, "Stored usage cost");
  const stopReason = message.stop_reason;
  if (
    stopReason !== "stop" &&
    stopReason !== "length" &&
    stopReason !== "toolUse" &&
    stopReason !== "error" &&
    stopReason !== "aborted"
  ) {
    throw new Error("Stored assistant stop_reason is invalid.");
  }
  const content = requireArray(message, "content").map((value) => {
    const decoded = decodeContent(value);
    if (decoded.type === "image") {
      throw new Error("Stored assistant content block is invalid.");
    }
    return decoded;
  });
  return {
    role: "assistant",
    content,
    api: requireString(message, "api") as AssistantMessage["api"],
    provider: requireString(message, "provider") as AssistantMessage["provider"],
    model: requireString(message, "model"),
    ...optionalMappedString(message, "response_model", "responseModel"),
    ...optionalMappedString(message, "response_id", "responseId"),
    usage: {
      input: requireNumber(usage, "input"),
      output: requireNumber(usage, "output"),
      cacheRead: requireNumber(usage, "cache_read"),
      cacheWrite: requireNumber(usage, "cache_write"),
      totalTokens: requireNumber(usage, "total_tokens"),
      cost: {
        input: requireNumber(cost, "input"),
        output: requireNumber(cost, "output"),
        cacheRead: requireNumber(cost, "cache_read"),
        cacheWrite: requireNumber(cost, "cache_write"),
        total: requireNumber(cost, "total"),
      },
    },
    stopReason,
    ...optionalMappedString(message, "error_message", "errorMessage"),
    timestamp: requireNumber(message, "timestamp"),
  };
}

function decodeToolResultMessage(
  message: Record<string, unknown>,
): ToolResultMessage {
  const content = requireArray(message, "content").map((value) => {
    const decoded = decodeContent(value);
    if (decoded.type === "thinking" || decoded.type === "toolCall") {
      throw new Error("Stored tool result content block is invalid.");
    }
    return decoded;
  });
  return {
    role: "toolResult",
    toolCallId: requireString(message, "tool_call_id"),
    toolName: requireString(message, "tool_name"),
    content,
    isError: requireBoolean(message, "is_error"),
    timestamp: requireNumber(message, "timestamp"),
  };
}

function decodeContent(
  value: unknown,
): TextContent | ImageContent | ThinkingContent | ToolCall {
  const content = requireRecord(value, "Stored content block");
  switch (content.type) {
    case "text":
      return {
        type: "text",
        text: requireString(content, "text", true),
        ...optionalMappedString(content, "text_signature", "textSignature"),
      };
    case "image":
      return {
        type: "image",
        data: requireString(content, "data"),
        mimeType: requireString(content, "mime_type"),
      };
    case "thinking": {
      const redacted = content.redacted;
      if (redacted !== undefined && typeof redacted !== "boolean") {
        throw new Error("Stored thinking redacted must be a boolean.");
      }
      return {
        type: "thinking",
        thinking: requireString(content, "thinking", true),
        ...optionalMappedString(
          content,
          "thinking_signature",
          "thinkingSignature",
        ),
        ...(redacted === undefined ? {} : { redacted }),
      };
    }
    case "tool_call":
      return {
        type: "toolCall",
        id: requireString(content, "id"),
        name: requireString(content, "name"),
        arguments: structuredClone(
          requireRecord(content.arguments, "Stored tool arguments"),
        ),
        ...optionalMappedString(
          content,
          "thought_signature",
          "thoughtSignature",
        ),
      };
    default:
      throw new Error("Stored content block type is invalid.");
  }
}

function optionalMappedString<TName extends string>(
  value: Record<string, unknown>,
  source: string,
  target: TName,
): Partial<Record<TName, string>> {
  const candidate = value[source];
  if (candidate === undefined) return {};
  if (typeof candidate !== "string") {
    throw new Error(`${source} must be a string.`);
  }
  return { [target]: candidate } as Partial<Record<TName, string>>;
}

function requireArray(
  value: Record<string, unknown>,
  field: string,
): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) throw new Error(`${field} must be an array.`);
  return candidate;
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
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

function requireNumber(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new Error(`${field} must be a finite number.`);
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
