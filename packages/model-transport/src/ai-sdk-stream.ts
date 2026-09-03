import { CompatibleStreamTruncatedError, frameCompatibleResponse } from "./compatible-sse.ts";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  JSONValue,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import {
  parseModelToolCall,
  type ModelRequest,
  type ModelToolCall,
  type ModelStreamEvent,
} from "./model-transport.ts";

type StreamOptions = {
  endpoint: string;
  fetch_request: typeof fetch;
  headers: Record<string, string>;
  send_reasoning_content: boolean;
};

/** Single model call only: DSH owns the tool loop, tokn owns its retries. */
export async function* streamCompatibleModel(
  request: ModelRequest,
  signal: AbortSignal,
  options: StreamOptions,
): AsyncIterable<ModelStreamEvent> {
  const provider = createOpenAICompatible({
    name: "rrbox",
    baseURL: "https://provider.researchbox.invalid/v1",
    fetch: async (_input, init) => {
      // Keep the native bridge's allowlist strict. SDK telemetry headers do not
      // belong on its wire protocol, and native credentials never enter JS.
      const response = await options.fetch_request(options.endpoint, {
        ...init,
        headers: {
          ...options.headers,
          accept: "text/event-stream",
          "content-type": "application/json",
        },
      });
      if (!response.ok) throw await createHttpError("Chat completions endpoint", response);
      return frameCompatibleResponse(response);
    },
  });
  const { stream } = await provider(request.model_id).doStream({
    prompt: toSdkPrompt(request, options.send_reasoning_content),
    tools: request.tools.map((tool): LanguageModelV4FunctionTool => {
      if (typeof tool.parameters !== "object" || tool.parameters === null) {
        throw new Error(`Invalid input schema for tool ${tool.name}.`);
      }
      return {
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      };
    }),
    // Use the compatible-provider string option, not the SDK's generic enum:
    // the selected model's catalog owns the vocabulary and exact wire ID.
    providerOptions: request.reasoning_effort === undefined ? undefined : {
      rrbox: { reasoningEffort: request.reasoning_effort },
    },
    abortSignal: signal,
    includeRawChunks: true,
  });

  const pendingToolCalls = new Map<number, PendingToolCall>();
  let activeScalarBlock: ActiveScalarBlock | undefined;
  let nextContentIndex = 0;
  let stopReason: "stop" | "length" | "tool_use" | undefined;
  for await (const data of readSdkChunks(stream, signal)) {
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


/** Map raw SDK chunks losslessly: rrbox permits fragmented tool identifiers
 * and interleaved blocks that the SDK's normalized tool events cannot retain.
 * AI SDK still owns request serialization, HTTP errors, and SSE/JSON parsing.
 */
async function* readSdkChunks(stream: ReadableStream<LanguageModelV4StreamPart>, signal: AbortSignal): AsyncIterable<string> {
  const reader = stream.getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return;
      if (value.type === "raw") {
        if (value.rawValue !== undefined) yield JSON.stringify(value.rawValue);
      } else if (value.type === "finish") {
        yield "[DONE]";
        return;
      } else if (value.type === "error") {
        throw value.error instanceof Error ? value.error : new Error("Provider stream failed.");
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && "cause" in error && error.cause instanceof CompatibleStreamTruncatedError) throw error.cause;
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function toSdkPrompt(request: ModelRequest, sendReasoning: boolean): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  if (request.system_prompt) prompt.push({ role: "system", content: request.system_prompt });
  for (const message of request.messages) {
    if (message.role === "user") {
      prompt.push({ role: "user", content: [{ type: "text", text: message.content }] });
    } else if (message.role === "tool") {
      prompt.push({ role: "tool", content: [{
        type: "tool-result", toolCallId: message.tool_call_id, toolName: message.tool_name,
        output: { type: message.is_error ? "error-text" : "text", value: message.content },
      }] });
    } else {
      const content: Extract<LanguageModelV4Message, { role: "assistant" }>["content"] = [];
      for (const block of message.content_blocks) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "reasoning") {
          if (sendReasoning) content.push({ type: "reasoning", text: block.reasoning });
        } else content.push({
          type: "tool-call", toolCallId: block.tool_call_id,
          toolName: block.tool_name, input: block.arguments as JSONValue,
        });
      }
      prompt.push({ role: "assistant", content });
    }
  }
  return prompt;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
