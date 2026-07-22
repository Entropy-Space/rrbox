import {
  parseModelToolCall,
  type ModelCatalogTransport,
  type ModelConversationMessage,
  type ModelDescriptor,
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
};

type PendingToolCall = {
  tool_call_id: string;
  tool_name: string;
  arguments_json: string;
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
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(toChatCompletionsRequest(request)),
      signal,
    });
    if (!response.ok) {
      throw await createHttpError("Chat completions endpoint", response);
    }
    if (!response.body) {
      throw new Error("Chat completions endpoint returned an empty body.");
    }

    const pendingToolCalls = new Map<number, PendingToolCall>();
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
        for (const toolCall of finalizeToolCalls(pendingToolCalls)) {
          yield { type: "tool_call", ...toolCall };
        }
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
        const content = choice.delta.content;
        if (content !== undefined && content !== null) {
          if (typeof content !== "string") {
            throw new Error("OpenAI-compatible text delta must be a string.");
          }
          if (content) yield { type: "text_delta", text_delta: content };
        }
        collectToolCallDeltas(choice.delta.tool_calls, pendingToolCalls);
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

function toChatCompletionsRequest(request: ModelRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (request.system_prompt) {
    messages.push({ role: "system", content: request.system_prompt });
  }
  messages.push(...request.messages.map(toOpenAiMessage));

  return {
    model: request.model_id,
    messages,
    ...(request.tools.length > 0
      ? { tools: request.tools.map(toOpenAiTool) }
      : {}),
    stream: true,
  };
}

function toOpenAiMessage(
  message: ModelConversationMessage,
): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.tool_calls.length > 0
          ? {
              tool_calls: message.tool_calls.map((toolCall) => ({
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
    supports_reasoning:
      capabilities && typeof capabilities.reasoning === "boolean"
        ? capabilities.reasoning
        : false,
  };
}

function collectToolCallDeltas(
  value: unknown,
  pendingToolCalls: Map<number, PendingToolCall>,
): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new Error("OpenAI-compatible tool_calls delta must be an array.");
  }

  for (const toolCall of value) {
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

    const pending = pendingToolCalls.get(toolCall.index) ?? {
      tool_call_id: "",
      tool_name: "",
      arguments_json: "",
    };
    if (toolCall.id !== undefined && toolCall.id !== null) {
      if (typeof toolCall.id !== "string") {
        throw new Error("OpenAI-compatible tool call id must be a string.");
      }
      pending.tool_call_id += toolCall.id;
    }
    if (toolCall.function !== undefined && toolCall.function !== null) {
      if (!isRecord(toolCall.function)) {
        throw new Error("OpenAI-compatible tool call function is malformed.");
      }
      const name = toolCall.function.name;
      if (name !== undefined && name !== null) {
        if (typeof name !== "string") {
          throw new Error("OpenAI-compatible tool name must be a string.");
        }
        pending.tool_name += name;
      }
      const argumentsJson = toolCall.function.arguments;
      if (argumentsJson !== undefined && argumentsJson !== null) {
        if (typeof argumentsJson !== "string") {
          throw new Error(
            "OpenAI-compatible tool arguments delta must be a string.",
          );
        }
        pending.arguments_json += argumentsJson;
      }
    }
    pendingToolCalls.set(toolCall.index, pending);
  }
}

function finalizeToolCalls(
  pendingToolCalls: Map<number, PendingToolCall>,
): ModelToolCall[] {
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
        return parseModelToolCall({
          tool_call_id: pending.tool_call_id,
          tool_name: pending.tool_name,
          arguments: argumentsValue,
        });
      } catch (error) {
        throw new Error(
          `Invalid tool call at index ${index}: ${errorMessage(error)}`,
        );
      }
    });
  const toolCallIds = new Set<string>();
  for (const toolCall of toolCalls) {
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
