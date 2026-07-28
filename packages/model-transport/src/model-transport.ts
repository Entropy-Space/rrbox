export type ModelToolName = string;

export type ModelToolCall = {
  tool_call_id: string;
  tool_name: ModelToolName;
  arguments: Record<string, unknown>;
};

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

export type ModelAssistantContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "reasoning";
      reasoning: string;
    }
  | ({ type: "tool_call" } & ModelToolCall);

export type ModelConversationMessage =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content_blocks: ModelAssistantContentBlock[];
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
  supports_reasoning_effort: boolean;
};

export type ModelStreamEvent =
  | { type: "text_start"; content_index: number }
  | { type: "text_delta"; content_index: number; text_delta: string }
  | { type: "text_end"; content_index: number }
  | { type: "reasoning_start"; content_index: number }
  | {
      type: "reasoning_delta";
      content_index: number;
      reasoning_delta: string;
    }
  | { type: "reasoning_end"; content_index: number }
  | { type: "tool_call_start"; content_index: number }
  | {
      type: "tool_call_delta";
      content_index: number;
      tool_call_id_delta?: string;
      tool_name_delta?: string;
      arguments_delta?: string;
    }
  | {
      type: "tool_call_end";
      content_index: number;
      tool_call: ModelToolCall;
    }
  | {
      type: "done";
      stop_reason?: "stop" | "length" | "tool_use";
    };

export type ModelRequest = {
  session_id: string;
  provider_id: string;
  model_id: string;
  system_prompt: string;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
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

  const reasoningEffort = parseReasoningEffort(value.reasoning_effort);
  return {
    session_id: requireIdentifier(value, "session_id"),
    provider_id: requireIdentifier(value, "provider_id"),
    model_id: requireIdentifier(value, "model_id"),
    system_prompt: requireString(value, "system_prompt", true),
    ...(reasoningEffort === undefined
      ? {}
      : { reasoning_effort: reasoningEffort }),
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
    supports_reasoning_effort:
      value.supports_reasoning_effort === undefined
        ? false
        : requireBoolean(value, "supports_reasoning_effort"),
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
    case "text_start":
      return {
        type: "text_start",
        content_index: requireContentIndex(value),
      };
    case "text_delta":
      return {
        type: "text_delta",
        content_index: requireContentIndex(value),
        text_delta: requireString(value, "text_delta", true),
      };
    case "text_end":
      return {
        type: "text_end",
        content_index: requireContentIndex(value),
      };
    case "reasoning_start":
      return {
        type: "reasoning_start",
        content_index: requireContentIndex(value),
      };
    case "reasoning_delta":
      return {
        type: "reasoning_delta",
        content_index: requireContentIndex(value),
        reasoning_delta: requireString(value, "reasoning_delta", true),
      };
    case "reasoning_end":
      return {
        type: "reasoning_end",
        content_index: requireContentIndex(value),
      };
    case "tool_call_start":
      return {
        type: "tool_call_start",
        content_index: requireContentIndex(value),
      };
    case "tool_call_delta": {
      const toolCallIdDelta = optionalString(value, "tool_call_id_delta");
      const toolNameDelta = optionalString(value, "tool_name_delta");
      const argumentsDelta = optionalString(value, "arguments_delta");
      if (
        toolCallIdDelta === undefined &&
        toolNameDelta === undefined &&
        argumentsDelta === undefined
      ) {
        throw new Error(
          "Tool call delta must contain at least one delta field.",
        );
      }
      return {
        type: "tool_call_delta",
        content_index: requireContentIndex(value),
        ...(toolCallIdDelta === undefined
          ? {}
          : { tool_call_id_delta: toolCallIdDelta }),
        ...(toolNameDelta === undefined
          ? {}
          : { tool_name_delta: toolNameDelta }),
        ...(argumentsDelta === undefined
          ? {}
          : { arguments_delta: argumentsDelta }),
      };
    }
    case "tool_call_end":
      return {
        type: "tool_call_end",
        content_index: requireContentIndex(value),
        tool_call: parseModelToolCall(value.tool_call),
      };
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

type OpenContentBlock =
  | {
      type: "text";
    }
  | {
      type: "reasoning";
    }
  | {
      type: "tool_call";
      tool_call_id: string;
      tool_name: string;
      arguments_json: string;
    };

export class ModelStreamEventSequenceValidator {
  private readonly openBlocks = new Map<number, OpenContentBlock>();
  private readonly completedToolCallIds = new Set<string>();
  private nextContentIndex = 0;
  private done = false;

  accept(value: unknown): ModelStreamEvent {
    const event = parseModelStreamEvent(value);
    if (this.done) {
      throw new Error("Model stream contains an event after done.");
    }

    switch (event.type) {
      case "text_start":
        this.startBlock(event.content_index, "text");
        break;
      case "reasoning_start":
        this.startBlock(event.content_index, "reasoning");
        break;
      case "tool_call_start":
        this.startBlock(event.content_index, "tool_call");
        break;
      case "text_delta":
        this.requireOpenBlock(event.content_index, "text");
        break;
      case "reasoning_delta":
        this.requireOpenBlock(event.content_index, "reasoning");
        break;
      case "tool_call_delta": {
        const block = this.requireOpenBlock(
          event.content_index,
          "tool_call",
        );
        block.tool_call_id += event.tool_call_id_delta ?? "";
        block.tool_name += event.tool_name_delta ?? "";
        block.arguments_json += event.arguments_delta ?? "";
        break;
      }
      case "text_end":
        this.endBlock(event.content_index, "text");
        break;
      case "reasoning_end":
        this.endBlock(event.content_index, "reasoning");
        break;
      case "tool_call_end": {
        const block = this.requireOpenBlock(
          event.content_index,
          "tool_call",
        );
        let fragmentCall: ModelToolCall;
        try {
          fragmentCall = parseModelToolCall({
            tool_call_id: block.tool_call_id,
            tool_name: block.tool_name,
            arguments: JSON.parse(block.arguments_json) as unknown,
          });
        } catch (error) {
          throw new Error(
            `Invalid accumulated tool call at content_index ${event.content_index}: ${errorMessage(error)}`,
          );
        }
        if (
          JSON.stringify(fragmentCall) !== JSON.stringify(event.tool_call)
        ) {
          throw new Error(
            `Tool call end does not match deltas at content_index ${event.content_index}.`,
          );
        }
        if (this.completedToolCallIds.has(event.tool_call.tool_call_id)) {
          throw new Error(
            `Duplicate completed tool_call_id: ${event.tool_call.tool_call_id}.`,
          );
        }
        this.completedToolCallIds.add(event.tool_call.tool_call_id);
        this.openBlocks.delete(event.content_index);
        break;
      }
      case "done":
        if (this.openBlocks.size > 0) {
          throw new Error("Model stream reached done with open content blocks.");
        }
        this.done = true;
        break;
    }

    return event;
  }

  assertComplete(): void {
    if (!this.done) {
      throw new Error("Model stream ended before a done event.");
    }
  }

  private startBlock(
    contentIndex: number,
    type: OpenContentBlock["type"],
  ): void {
    if (contentIndex !== this.nextContentIndex) {
      throw new Error(
        `Expected content_index ${this.nextContentIndex}, received ${contentIndex}.`,
      );
    }
    this.nextContentIndex += 1;
    this.openBlocks.set(
      contentIndex,
      type === "tool_call"
        ? {
            type,
            tool_call_id: "",
            tool_name: "",
            arguments_json: "",
          }
        : { type },
    );
  }

  private endBlock(
    contentIndex: number,
    type: "text" | "reasoning",
  ): void {
    this.requireOpenBlock(contentIndex, type);
    this.openBlocks.delete(contentIndex);
  }

  private requireOpenBlock<TType extends OpenContentBlock["type"]>(
    contentIndex: number,
    type: TType,
  ): Extract<OpenContentBlock, { type: TType }> {
    const block = this.openBlocks.get(contentIndex);
    if (!block || block.type !== type) {
      throw new Error(
        `No open ${type} block at content_index ${contentIndex}.`,
      );
    }
    return block as Extract<OpenContentBlock, { type: TType }>;
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
      if (!Array.isArray(value.content_blocks)) {
        throw new Error(
          "Assistant message content_blocks must be an array.",
        );
      }
      const contentBlocks = value.content_blocks.map(
        parseAssistantContentBlock,
      );
      if (contentBlocks.length === 0) {
        throw new Error(
          "Assistant message must contain at least one content block.",
        );
      }
      return {
        role: "assistant",
        content_blocks: contentBlocks,
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

function parseAssistantContentBlock(
  value: unknown,
): ModelAssistantContentBlock {
  if (!isRecord(value)) {
    throw new Error("Assistant content block must be an object.");
  }
  switch (value.type) {
    case "text":
      return {
        type: "text",
        text: requireString(value, "text"),
      };
    case "reasoning":
      return {
        type: "reasoning",
        reasoning: requireString(value, "reasoning"),
      };
    case "tool_call":
      return {
        type: "tool_call",
        ...parseModelToolCall(value),
      };
    default:
      throw new Error(
        `Unsupported assistant content block: ${String(value.type)}`,
      );
  }
}

export function parseModelToolCall(value: unknown): ModelToolCall {
  if (!isRecord(value)) throw new Error("Tool call must be an object.");
  if (!isRecord(value.arguments)) {
    throw new Error("Tool call arguments must be an object.");
  }
  const toolCallId = requireIdentifier(value, "tool_call_id");
  const toolName = requireModelToolName(value.tool_name);

  switch (toolName) {
    case "list_files":
    case "read_file":
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: {
          path: requireString(value.arguments, "path"),
        },
      };
    case "search_files":
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: {
          path: requireString(value.arguments, "path"),
          query: requireString(value.arguments, "query"),
        },
      };
    case "write_file":
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: {
          path: requireString(value.arguments, "path"),
          content: requireString(value.arguments, "content", true),
        },
      };
    case "replace_text":
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: {
          path: requireString(value.arguments, "path"),
          old_text: requireString(value.arguments, "old_text", true),
          new_text: requireString(value.arguments, "new_text", true),
        },
      };
    case "remove_file":
      assertExactKeys(value.arguments, ["path"], "remove_file arguments");
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: {
          path: requireString(value.arguments, "path"),
        },
      };
    default:
      return {
        tool_call_id: toolCallId,
        tool_name: toolName,
        arguments: cloneJsonObject(
          value.arguments,
          `${toolName} arguments`,
        ),
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
    parameters: cloneJsonValue(
      value.parameters,
      "Tool definition parameters",
    ),
  };
}

export function isModelToolName(value: unknown): value is ModelToolName {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(value)
  );
}

function requireModelToolName(value: unknown): ModelToolName {
  if (!isModelToolName(value)) {
    throw new Error(`Invalid tool name: ${String(value)}`);
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

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `${label} must contain exactly: ${expected.join(", ")}.`,
    );
  }
}

function cloneJsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return cloneJsonValue(value, label) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown, label: string): unknown {
  assertJsonValue(value, label, new Set<object>());
  return structuredClone(value);
}

function assertJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must contain only JSON values.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must contain only JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} cannot contain cycles.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item, label, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only JSON values.`);
    }
    for (const item of Object.values(value)) {
      assertJsonValue(item, label, ancestors);
    }
  }
  ancestors.delete(value);
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

function optionalString(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return candidate;
}

function requireContentIndex(value: Record<string, unknown>): number {
  const contentIndex = value.content_index;
  if (
    typeof contentIndex !== "number" ||
    !Number.isSafeInteger(contentIndex) ||
    contentIndex < 0
  ) {
    throw new Error("content_index must be a non-negative integer.");
  }
  return contentIndex;
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

function parseReasoningEffort(
  value: unknown,
): ModelRequest["reasoning_effort"] {
  if (value === undefined) return undefined;
  if (
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh"
  ) {
    throw new Error("Invalid reasoning_effort.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
