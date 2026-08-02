import {
  parseModelToolCall,
  type ModelCatalogTransport,
  type ModelConversationMessage,
  type ModelDescriptor,
  type ModelReasoningEffort,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelToolCall,
  type ModelToolDefinition,
} from "./model-transport.ts";

export type OpenAiCompatibleModelTransportOptions = {
  provider_id: string;
  provider_display_name: string;
  models_endpoint: string;
  chat_completions_endpoint: string;
  request_headers?: Record<string, string>;
  fetch_request?: typeof fetch;
  /**
   * Send Pi-compatible session-affinity headers on chat completions requests.
   * OpenAI-compatible providers vary in whether they accept these headers, so
   * this must be enabled by the provider composition that opts into them.
   */
  send_session_affinity_headers?: boolean;
  /**
   * Opt in only for endpoints that accept reasoning_content on assistant
   * history messages. Canonical reasoning is retained when this is false.
   */
  send_reasoning_content?: boolean;
};

type PendingToolCall = {
  content_index: number;
  tool_call_id: string;
  tool_name: string;
  arguments_json: string;
};

type ActiveScalarBlock = {
  type: "text" | "reasoning";
  content_index: number;
};

type ToolCallFragment = {
  provider_index: number;
  tool_call_id_delta?: string;
  tool_name_delta?: string;
  arguments_delta?: string;
};

export class OpenAiCompatibleModelTransport
  implements ModelCatalogTransport
{
  private readonly providerId: string;
  private readonly providerDisplayName: string;
  private readonly modelsEndpoint: string;
  private readonly chatCompletionsEndpoint: string;
  private readonly requestHeaders: Record<string, string>;
  private readonly fetchRequest: typeof fetch;
  private readonly sendSessionAffinityHeaders: boolean;
  private readonly sendReasoningContent: boolean;

  constructor(options: OpenAiCompatibleModelTransportOptions) {
    this.providerId = requireNonEmptyOption(options.provider_id, "provider_id");
    this.providerDisplayName = requireNonEmptyOption(
      options.provider_display_name,
      "provider_display_name",
    );
    this.modelsEndpoint = requireNonEmptyOption(
      options.models_endpoint,
      "models_endpoint",
    );
    this.chatCompletionsEndpoint = requireNonEmptyOption(
      options.chat_completions_endpoint,
      "chat_completions_endpoint",
    );
    this.requestHeaders = { ...options.request_headers };
    this.fetchRequest = (options.fetch_request ?? fetch).bind(globalThis);
    if (
      options.send_session_affinity_headers !== undefined &&
      typeof options.send_session_affinity_headers !== "boolean"
    ) {
      throw new Error("send_session_affinity_headers must be a boolean.");
    }
    this.sendSessionAffinityHeaders =
      options.send_session_affinity_headers ?? false;
    if (
      options.send_reasoning_content !== undefined &&
      typeof options.send_reasoning_content !== "boolean"
    ) {
      throw new Error("send_reasoning_content must be a boolean.");
    }
    this.sendReasoningContent = options.send_reasoning_content ?? false;
  }

  async listModels(signal: AbortSignal): Promise<ModelDescriptor[]> {
    signal.throwIfAborted();
    const response = await this.fetchRequest(this.modelsEndpoint, {
      method: "GET",
      headers: {
        ...this.requestHeaders,
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) {
      throw await createHttpError("Models endpoint", response);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        `Models endpoint returned malformed JSON: ${errorMessage(error)}`,
      );
    }
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error("Models endpoint response must contain a data array.");
    }

    const models = payload.data.map((entry, index) => {
      try {
        return parseCatalogEntry(
          entry,
          this.providerId,
          this.providerDisplayName,
        );
      } catch (error) {
        throw new Error(
          `Invalid model at data[${index}]: ${errorMessage(error)}`,
        );
      }
    });

    return [
      ...new Map(models.map((model) => [model.model_id, model])).values(),
    ].sort((left, right) => left.model_id.localeCompare(right.model_id));
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    signal.throwIfAborted();
    if (request.provider_id !== this.providerId) {
      throw new Error(
        `Provider ${request.provider_id} cannot be handled by ${this.providerId}.`,
      );
    }

    const response = await this.fetchRequest(this.chatCompletionsEndpoint, {
      method: "POST",
      headers: {
        ...this.requestHeaders,
        ...(this.sendSessionAffinityHeaders
          ? createSessionAffinityHeaders(request.session_id)
          : {}),
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        toChatCompletionsRequest(request, this.sendReasoningContent),
      ),
      signal,
    });
    if (!response.ok) {
      throw await createHttpError("Chat completions endpoint", response);
    }
    if (!response.body) {
      throw new Error("Chat completions endpoint returned an empty body.");
    }

    const pendingToolCalls = new Map<number, PendingToolCall>();
    let activeScalarBlock: ActiveScalarBlock | undefined;
    let nextContentIndex = 0;
    let stopReason: "stop" | "length" | "tool_use" | undefined;
    for await (const data of readSseData(response.body, signal)) {
      signal.throwIfAborted();
      if (data.trim() === "[DONE]") {
        if (stopReason === "tool_use" && pendingToolCalls.size === 0) {
          throw new Error(
            "OpenAI-compatible endpoint reported tool calls without returning one.",
          );
        }
        if (stopReason === "length" && pendingToolCalls.size > 0) {
          throw new Error(
            "OpenAI-compatible endpoint truncated a tool call at the token limit.",
          );
        }
        if (activeScalarBlock) {
          signal.throwIfAborted();
          yield scalarEndEvent(activeScalarBlock);
          activeScalarBlock = undefined;
        }
        for (const completed of finalizeToolCalls(pendingToolCalls)) {
          signal.throwIfAborted();
          yield {
            type: "tool_call_end",
            content_index: completed.content_index,
            tool_call: completed.tool_call,
          };
        }
        signal.throwIfAborted();
        yield {
          type: "done",
          stop_reason:
            pendingToolCalls.size > 0 ? "tool_use" : (stopReason ?? "stop"),
        };
        return;
      }

      let chunk: unknown;
      try {
        chunk = JSON.parse(data) as unknown;
      } catch (error) {
        throw new Error(
          `Malformed OpenAI-compatible stream JSON: ${errorMessage(error)}`,
        );
      }
      if (!isRecord(chunk)) {
        throw new Error("OpenAI-compatible stream chunk must be an object.");
      }
      const apiError = readApiError(chunk);
      if (apiError) {
        throw new Error(`OpenAI-compatible endpoint error: ${apiError}`);
      }
      if (!Array.isArray(chunk.choices)) {
        throw new Error(
          "OpenAI-compatible stream chunk must contain a choices array.",
        );
      }

      for (const choice of chunk.choices) {
        if (!isRecord(choice) || choice.index !== 0) continue;
        const finishReason = choice.finish_reason;
        if (finishReason !== undefined && finishReason !== null) {
          stopReason = parseFinishReason(finishReason);
        }
        if (!isRecord(choice.delta)) continue;

        const reasoning = readReasoningDelta(choice.delta);
        if (reasoning) {
          const transition = transitionScalarBlock(
            activeScalarBlock,
            "reasoning",
            nextContentIndex,
          );
          activeScalarBlock = transition.block;
          nextContentIndex = transition.next_content_index;
          for (const event of transition.events) {
            signal.throwIfAborted();
            yield event;
          }
          signal.throwIfAborted();
          yield {
            type: "reasoning_delta",
            content_index: activeScalarBlock.content_index,
            reasoning_delta: reasoning,
          };
        }

        const content = choice.delta.content;
        if (content !== undefined && content !== null) {
          if (typeof content !== "string") {
            throw new Error("OpenAI-compatible text delta must be a string.");
          }
          if (content) {
            const transition = transitionScalarBlock(
              activeScalarBlock,
              "text",
              nextContentIndex,
            );
            activeScalarBlock = transition.block;
            nextContentIndex = transition.next_content_index;
            for (const event of transition.events) {
              signal.throwIfAborted();
              yield event;
            }
            signal.throwIfAborted();
            yield {
              type: "text_delta",
              content_index: activeScalarBlock.content_index,
              text_delta: content,
            };
          }
        }

        const fragments = parseToolCallFragments(choice.delta.tool_calls);
        if (fragments.length > 0) {
          if (activeScalarBlock) {
            signal.throwIfAborted();
            yield scalarEndEvent(activeScalarBlock);
            activeScalarBlock = undefined;
          }
          for (const fragment of fragments) {
            let pending = pendingToolCalls.get(fragment.provider_index);
            if (!pending) {
              pending = {
                content_index: nextContentIndex,
                tool_call_id: "",
                tool_name: "",
                arguments_json: "",
              };
              nextContentIndex += 1;
              pendingToolCalls.set(fragment.provider_index, pending);
              signal.throwIfAborted();
              yield {
                type: "tool_call_start",
                content_index: pending.content_index,
              };
            }

            pending.tool_call_id += fragment.tool_call_id_delta ?? "";
            pending.tool_name += fragment.tool_name_delta ?? "";
            pending.arguments_json += fragment.arguments_delta ?? "";
            if (
              fragment.tool_call_id_delta ||
              fragment.tool_name_delta ||
              fragment.arguments_delta
            ) {
              signal.throwIfAborted();
              yield {
                type: "tool_call_delta",
                content_index: pending.content_index,
                ...(fragment.tool_call_id_delta
                  ? {
                      tool_call_id_delta: fragment.tool_call_id_delta,
                    }
                  : {}),
                ...(fragment.tool_name_delta
                  ? { tool_name_delta: fragment.tool_name_delta }
                  : {}),
                ...(fragment.arguments_delta
                  ? { arguments_delta: fragment.arguments_delta }
                  : {}),
              };
            }
          }
        }
      }
    }

    signal.throwIfAborted();
    throw new Error("OpenAI-compatible stream ended before [DONE].");
  }
}

function parseFinishReason(
  value: unknown,
): "stop" | "length" | "tool_use" {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "tool_calls") return "tool_use";
  throw new Error(
    `Unsupported OpenAI-compatible finish_reason: ${String(value)}`,
  );
}

function transitionScalarBlock(
  activeBlock: ActiveScalarBlock | undefined,
  type: ActiveScalarBlock["type"],
  nextContentIndex: number,
): {
  block: ActiveScalarBlock;
  events: ModelStreamEvent[];
  next_content_index: number;
} {
  if (activeBlock?.type === type) {
    return {
      block: activeBlock,
      events: [],
      next_content_index: nextContentIndex,
    };
  }

  const block = { type, content_index: nextContentIndex };
  return {
    block,
    events: [
      ...(activeBlock ? [scalarEndEvent(activeBlock)] : []),
      {
        type: type === "text" ? "text_start" : "reasoning_start",
        content_index: block.content_index,
      },
    ],
    next_content_index: nextContentIndex + 1,
  };
}

function scalarEndEvent(block: ActiveScalarBlock): ModelStreamEvent {
  return {
    type: block.type === "text" ? "text_end" : "reasoning_end",
    content_index: block.content_index,
  };
}

const REASONING_DELTA_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
  "thinking",
] as const;

function readReasoningDelta(
  delta: Record<string, unknown>,
): string | undefined {
  const candidates: { field: string; value: string }[] = [];
  for (const field of REASONING_DELTA_FIELDS) {
    const value = delta[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new Error(
        `OpenAI-compatible ${field} delta must be a string.`,
      );
    }
    if (value) candidates.push({ field, value });
  }
  if (candidates.length === 0) return undefined;

  const [{ value }] = candidates;
  const conflicting = candidates.find(
    (candidate) => candidate.value !== value,
  );
  if (conflicting) {
    throw new Error(
      `OpenAI-compatible stream returned conflicting reasoning deltas in ${candidates.map((candidate) => candidate.field).join(" and ")}.`,
    );
  }
  return value;
}

function createSessionAffinityHeaders(
  sessionId: string,
): Record<string, string> {
  return {
    session_id: sessionId,
    "x-client-request-id": sessionId,
    "x-session-affinity": sessionId,
  };
}

function toChatCompletionsRequest(
  request: ModelRequest,
  sendReasoningContent: boolean,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (request.system_prompt) {
    messages.push({ role: "system", content: request.system_prompt });
  }
  messages.push(
    ...request.messages.map((message) =>
      toOpenAiMessage(message, sendReasoningContent),
    ),
  );

  return {
    model: request.model_id,
    messages,
    ...(request.reasoning_effort === undefined
      ? {}
      : { reasoning_effort: request.reasoning_effort }),
    ...(request.tools.length > 0
      ? { tools: request.tools.map(toOpenAiTool) }
      : {}),
    stream: true,
  };
}

function toOpenAiMessage(
  message: ModelConversationMessage,
  sendReasoningContent: boolean,
): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      // Chat Completions splits text, reasoning, and tool calls into separate
      // fields. The canonical content_blocks retain their exact interleaving;
      // this provider projection preserves order within each supported field.
      const text = message.content_blocks
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      const reasoning = message.content_blocks
        .flatMap((block) =>
          block.type === "reasoning" ? [block.reasoning] : [],
        )
        .join("");
      const toolCalls = message.content_blocks.flatMap((block) =>
        block.type === "tool_call" ? [block] : [],
      );
      return {
        role: "assistant",
        content: text || null,
        ...(sendReasoningContent && reasoning
          ? { reasoning_content: reasoning }
          : {}),
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((toolCall) => ({
                id: toolCall.tool_call_id,
                type: "function",
                function: {
                  name: toolCall.tool_name,
                  arguments: JSON.stringify(toolCall.arguments),
                },
              })),
            }
          : {}),
      };
    }
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: message.content,
      };
  }
}

function toOpenAiTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function parseCatalogEntry(
  value: unknown,
  providerId: string,
  providerDisplayName: string,
): ModelDescriptor {
  if (!isRecord(value)) throw new Error("Model entry must be an object.");
  const modelId = readNonEmptyString(value.id);
  if (!modelId) throw new Error("id must be a non-empty string.");

  const metadata = isRecord(value.x_tokn_router)
    ? value.x_tokn_router
    : undefined;
  const capabilities =
    metadata && isRecord(metadata.capabilities)
      ? metadata.capabilities
      : undefined;
  const limit =
    metadata && isRecord(metadata.limit) ? metadata.limit : undefined;
  const supportsReasoning =
    capabilities && typeof capabilities.reasoning === "boolean"
      ? capabilities.reasoning
      : false;
  const reasoningEfforts = parseRouterReasoningEfforts(
    capabilities,
    supportsReasoning,
  );

  return {
    provider_id: providerId,
    provider_display_name: providerDisplayName,
    model_id: modelId,
    display_name:
      (metadata && readNonEmptyString(metadata.name)) ??
      readNonEmptyString(value.name) ??
      modelId,
    context_window: readPositiveInteger(limit?.context),
    max_output_tokens: readPositiveInteger(limit?.output),
    supports_tools:
      capabilities && typeof capabilities.toolcall === "boolean"
        ? capabilities.toolcall
        : true,
    supports_reasoning: supportsReasoning,
    supports_reasoning_effort: reasoningEfforts.length > 0,
    reasoning_efforts: reasoningEfforts,
  };
}

function parseRouterReasoningEfforts(
  capabilities: Record<string, unknown> | undefined,
  supportsReasoning: boolean,
): ModelReasoningEffort[] {
  const configured = capabilities?.reasoning_efforts;
  if (configured !== undefined) {
    if (!Array.isArray(configured)) {
      throw new Error("capabilities.reasoning_efforts must be an array.");
    }
    const efforts = configured.map((effort) => {
      if (!isModelReasoningEffort(effort)) {
        throw new Error("Invalid capabilities.reasoning_efforts value.");
      }
      return effort;
    });
    if (new Set(efforts).size !== efforts.length) {
      throw new Error("capabilities.reasoning_efforts contains duplicates.");
    }
    if (!supportsReasoning && efforts.length > 0) {
      throw new Error(
        "A non-reasoning model cannot advertise reasoning efforts.",
      );
    }
    return efforts;
  }
  if (capabilities?.reasoning_effort === true) {
    return ["minimal", "low", "medium", "high", "xhigh"];
  }
  return supportsReasoning ? ["none", "low", "medium", "high"] : [];
}

function isModelReasoningEffort(
  value: unknown,
): value is ModelReasoningEffort {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh";
}

function parseToolCallFragments(value: unknown): ToolCallFragment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("OpenAI-compatible tool_calls delta must be an array.");
  }

  const fragments = value.map((toolCall): ToolCallFragment => {
    if (!isRecord(toolCall)) {
      throw new Error("OpenAI-compatible tool call delta must be an object.");
    }
    if (
      typeof toolCall.index !== "number" ||
      !Number.isSafeInteger(toolCall.index) ||
      toolCall.index < 0
    ) {
      throw new Error("OpenAI-compatible tool call index must be an integer.");
    }

    let toolCallIdDelta: string | undefined;
    if (toolCall.id !== undefined && toolCall.id !== null) {
      if (typeof toolCall.id !== "string") {
        throw new Error("OpenAI-compatible tool call id must be a string.");
      }
      toolCallIdDelta = toolCall.id;
    }

    let toolNameDelta: string | undefined;
    let argumentsDelta: string | undefined;
    if (toolCall.function !== undefined && toolCall.function !== null) {
      if (!isRecord(toolCall.function)) {
        throw new Error("OpenAI-compatible tool call function is malformed.");
      }
      const name = toolCall.function.name;
      if (name !== undefined && name !== null) {
        if (typeof name !== "string") {
          throw new Error("OpenAI-compatible tool name must be a string.");
        }
        toolNameDelta = name;
      }
      const argumentsJson = toolCall.function.arguments;
      if (argumentsJson !== undefined && argumentsJson !== null) {
        if (typeof argumentsJson !== "string") {
          throw new Error(
            "OpenAI-compatible tool arguments delta must be a string.",
          );
        }
        argumentsDelta = argumentsJson;
      }
    }

    return {
      provider_index: toolCall.index,
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
  });
  return fragments.sort(
    (left, right) => left.provider_index - right.provider_index,
  );
}

function finalizeToolCalls(
  pendingToolCalls: Map<number, PendingToolCall>,
): { content_index: number; tool_call: ModelToolCall }[] {
  const toolCalls = [...pendingToolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, pending]) => {
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(pending.arguments_json) as unknown;
      } catch (error) {
        throw new Error(
          `Malformed tool arguments at index ${index}: ${errorMessage(error)}`,
        );
      }

      try {
        return {
          content_index: pending.content_index,
          tool_call: parseModelToolCall({
            tool_call_id: pending.tool_call_id,
            tool_name: pending.tool_name,
            arguments: argumentsValue,
          }),
        };
      } catch (error) {
        throw new Error(
          `Invalid tool call at index ${index}: ${errorMessage(error)}`,
        );
      }
    });
  const toolCallIds = new Set<string>();
  for (const { tool_call: toolCall } of toolCalls) {
    if (toolCallIds.has(toolCall.tool_call_id)) {
      throw new Error(
        `OpenAI-compatible endpoint returned duplicate tool call id: ${toolCall.tool_call_id}`,
      );
    }
    toolCallIds.add(toolCall.tool_call_id);
  }
  return toolCalls;
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sourceEnded = false;

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      sourceEnded = done;
      buffer += decoder.decode(value, { stream: !done });

      let boundary = findEventBoundary(buffer);
      while (boundary) {
        signal.throwIfAborted();
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = readEventData(block);
        if (data !== undefined) yield data;
        boundary = findEventBoundary(buffer);
      }

      if (done) {
        if (buffer.trim()) {
          const data = readEventData(buffer);
          if (data !== undefined) yield data;
        }
        return;
      }
    }
  } finally {
    if (!sourceEnded) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function findEventBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function readEventData(block: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === "data") {
      dataLines.push("");
    } else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return dataLines.length > 0 ? dataLines.join("\n") : undefined;
}

async function createHttpError(
  label: string,
  response: Response,
): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.text()).slice(0, 500);
    if (body) {
      try {
        const value = JSON.parse(body) as unknown;
        detail = readApiError(value) ?? body;
      } catch {
        detail = body;
      }
    }
  } catch {
    // The status code still gives the caller a useful error.
  }
  return new Error(
    `${label} returned ${response.status}${detail ? `: ${detail}` : "."}`,
  );
}

function readApiError(value: unknown): string | undefined {
  if (!isRecord(value) || value.error === undefined) return undefined;
  if (typeof value.error === "string") return value.error;
  if (isRecord(value.error)) {
    return (
      readNonEmptyString(value.error.message) ??
      readNonEmptyString(value.error.code) ??
      "Unknown API error."
    );
  }
  return String(value.error);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function requireNonEmptyOption(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
