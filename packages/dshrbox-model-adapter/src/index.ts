import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type ToolCallBlock,
} from "@deepseek-ai/dsh-llm";
import {
  isModelToolName,
  ModelStreamEventSequenceValidator,
  parseModelDescriptors,
  parseModelRequest,
  parseModelToolCall,
  type ModelAssistantContentBlock,
  type ModelConversationMessage,
  type ModelDescriptor,
  type ModelReasoningEffort,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTransport,
} from "@researchbox/model-transport";

export interface ProviderModelCatalog {
  listModels(
    providerId: string,
    signal: AbortSignal,
  ): Promise<readonly ModelDescriptor[]>;
}

type OpenBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      tool_call_id: string;
      tool_name: string;
      arguments_json: string;
    };

export class ModelTransportLlmAdapter extends LlmAdapter {
  private readonly transport: ModelTransport;
  private readonly modelCatalog?: ProviderModelCatalog;

  constructor(
    transport: ModelTransport,
    modelCatalog?: ProviderModelCatalog,
  ) {
    super();
    this.transport = transport;
    this.modelCatalog = modelCatalog;
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (!this.modelCatalog) return [];
    const descriptors = parseModelDescriptors(
      await this.modelCatalog.listModels(
        provider,
        new AbortController().signal,
      ),
    );
    return descriptors
      .filter((descriptor) => descriptor.provider_id === provider)
      .map(toLlmModelInfo);
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (signal?.aborted) throw createAbortError();
    const fallback = unresolvedModel(provider, model);
    if (!this.modelCatalog) return fallback;

    const catalogSignal = signal ?? new AbortController().signal;
    try {
      const descriptors = parseModelDescriptors(
        await this.modelCatalog.listModels(provider, catalogSignal),
      );
      if (catalogSignal.aborted) throw createAbortError();
      const descriptor = descriptors.find((candidate) =>
        candidate.provider_id === provider && candidate.model_id === model
      );
      return descriptor ? toResolvedModelInfo(descriptor) : fallback;
    } catch {
      if (catalogSignal.aborted) throw createAbortError();
      return fallback;
    }
  }

  override async *stream(
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw createAbortError();
    const request = toModelRequest(options);
    const validator = new ModelStreamEventSequenceValidator();
    const openBlocks = new Map<number, OpenBlock>();
    let doneEvent: Extract<ModelStreamEvent, { type: "done" }> | undefined;
    let completedToolCalls = 0;

    for await (const candidate of this.transport.stream(request, signal)) {
      if (signal.aborted) throw createAbortError();
      const event = validator.accept(candidate);

      switch (event.type) {
        case "text_start":
          openBlocks.set(event.content_index, { type: "text", text: "" });
          yield {
            type: "block-start",
            index: event.content_index,
            blockType: "text",
          };
          break;
        case "text_delta": {
          const block = requireOpenBlock(
            openBlocks,
            event.content_index,
            "text",
          );
          block.text += event.text_delta;
          yield {
            type: "text-delta",
            index: event.content_index,
            text: event.text_delta,
          };
          break;
        }
        case "text_end": {
          const block = requireOpenBlock(
            openBlocks,
            event.content_index,
            "text",
          );
          openBlocks.delete(event.content_index);
          yield {
            type: "block-end",
            index: event.content_index,
            block: { type: "text", text: block.text },
          };
          break;
        }
        case "reasoning_start":
          openBlocks.set(event.content_index, {
            type: "reasoning",
            text: "",
          });
          yield {
            type: "block-start",
            index: event.content_index,
            blockType: "reasoning",
          };
          break;
        case "reasoning_delta": {
          const block = requireOpenBlock(
            openBlocks,
            event.content_index,
            "reasoning",
          );
          block.text += event.reasoning_delta;
          yield {
            type: "reasoning-delta",
            index: event.content_index,
            text: event.reasoning_delta,
          };
          break;
        }
        case "reasoning_end": {
          const block = requireOpenBlock(
            openBlocks,
            event.content_index,
            "reasoning",
          );
          openBlocks.delete(event.content_index);
          yield {
            type: "block-end",
            index: event.content_index,
            block: { type: "reasoning", text: block.text },
          };
          break;
        }
        case "tool_call_start":
          openBlocks.set(event.content_index, {
            type: "tool_call",
            tool_call_id: "",
            tool_name: "",
            arguments_json: "",
          });
          yield {
            type: "block-start",
            index: event.content_index,
            blockType: "tool-call",
          };
          break;
        case "tool_call_delta": {
          const block = requireOpenBlock(
            openBlocks,
            event.content_index,
            "tool_call",
          );
          block.tool_call_id += event.tool_call_id_delta ?? "";
          block.tool_name += event.tool_name_delta ?? "";
          block.arguments_json += event.arguments_delta ?? "";
          break;
        }
        case "tool_call_end": {
          const block = requireOpenBlock(
            openBlocks,
            event.content_index,
            "tool_call",
          );
          openBlocks.delete(event.content_index);
          completedToolCalls += 1;
          const callId = CallId(event.tool_call.tool_call_id);
          yield {
            type: "tool-call-delta",
            index: event.content_index,
            id: callId,
            name: event.tool_call.tool_name,
            argumentsDelta: block.arguments_json,
          };
          yield {
            type: "block-end",
            index: event.content_index,
            block: {
              type: "tool-call",
              id: callId,
              name: event.tool_call.tool_name,
              arguments: block.arguments_json,
            },
          };
          break;
        }
        case "done":
          doneEvent = event;
          break;
      }
    }

    validator.assertComplete();
    if (signal.aborted) throw createAbortError();
    if (!doneEvent) {
      throw new Error("Model transport ended before a done event.");
    }
    yield {
      type: "finish",
      reason: toFinishReason(doneEvent, completedToolCalls),
    };
  }
}

export function toModelRequest(options: GenerateOptions): ModelRequest {
  rejectUnsupportedControls(options);
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const request = {
    session_id: sessionId,
    provider_id: options.provider,
    model_id: options.model,
    system_prompt: options.system ?? "",
    ...(options.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: String(options.reasoningEffort) }),
    messages: toConversationMessages(options.messages),
    tools: (options.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
  return parseModelRequest(request);
}

function toConversationMessages(
  messages: readonly Message[],
): ModelConversationMessage[] {
  const result: ModelConversationMessage[] = [];
  const pendingToolNames = new Map<string, string>();
  const seenToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "system") {
      throw new Error(
        "System messages must be supplied through GenerateOptions.system.",
      );
    }

    if (message.role === "assistant") {
      const contentBlocks: ModelAssistantContentBlock[] = [];
      for (const block of message.content) {
        switch (block.type) {
          case "text":
            if (block.text.length > 0) {
              contentBlocks.push({ type: "text", text: block.text });
            }
            break;
          case "reasoning":
            if (block.text.length > 0) {
              contentBlocks.push({
                type: "reasoning",
                reasoning: block.text,
              });
            }
            break;
          case "tool-call": {
            const toolCall = toModelToolCall(block);
            if (seenToolCallIds.has(toolCall.tool_call_id)) {
              throw new Error(
                `Duplicate DSH tool call id: ${toolCall.tool_call_id}.`,
              );
            }
            seenToolCallIds.add(toolCall.tool_call_id);
            pendingToolNames.set(
              toolCall.tool_call_id,
              toolCall.tool_name,
            );
            contentBlocks.push({ type: "tool_call", ...toolCall });
            break;
          }
          default:
            throw unsupportedBlock(block, "assistant message");
        }
      }
      if (contentBlocks.length > 0) {
        result.push({ role: "assistant", content_blocks: contentBlocks });
      }
      continue;
    }

    if (message.source.kind === "tool") {
      result.push(
        toToolResultMessage(
          message,
          String(message.source.callId),
          pendingToolNames,
        ),
      );
      continue;
    }

    result.push({
      role: "user",
      content: textContent(message.content, "user message"),
    });
  }

  if (pendingToolNames.size > 0) {
    throw new Error(
      `Missing DSH tool results for: ${[...pendingToolNames.keys()].join(", ")}.`,
    );
  }
  return result;
}

function toToolResultMessage(
  message: Message,
  sourceCallId: string,
  pendingToolNames: Map<string, string>,
): ModelConversationMessage {
  if (message.content.length !== 1) {
    throw new Error("A DSH tool message must contain exactly one result.");
  }
  const block = message.content[0];
  if (block?.type !== "tool-result") {
    throw new Error("A DSH tool message must contain a tool-result block.");
  }
  if (block.toolCallId !== sourceCallId) {
    throw new Error("DSH tool result source and block call ids do not match.");
  }
  const toolCallId = String(block.toolCallId);
  const toolName = pendingToolNames.get(toolCallId);
  if (!toolName) {
    throw new Error(`DSH tool result has no matching call: ${toolCallId}.`);
  }
  pendingToolNames.delete(toolCallId);
  return {
    role: "tool",
    tool_call_id: toolCallId,
    tool_name: toolName,
    content: textContent(block.content, "tool result"),
    is_error: block.isError ?? false,
  };
}

function toModelToolCall(block: ToolCallBlock) {
  if (!isModelToolName(block.name)) {
    throw new Error(`Invalid DSH tool name: ${block.name}.`);
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(block.arguments) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON arguments for DSH tool ${block.name}.`,
      { cause: error },
    );
  }
  return parseModelToolCall({
    tool_call_id: String(block.id),
    tool_name: block.name,
    arguments: argumentsValue,
  });
}

function textContent(
  blocks: readonly ContentBlock[],
  location: string,
): string {
  return blocks.map((block) => {
    if (block.type !== "text") throw unsupportedBlock(block, location);
    return block.text;
  }).join("\n");
}

function unsupportedBlock(block: ContentBlock, location: string): Error {
  return new Error(
    `Unsupported DSH ${String(block.type)} block in ${location}.`,
  );
}

function rejectUnsupportedControls(options: GenerateOptions): void {
  const unsupported = [
    options.temperature === undefined ? undefined : "temperature",
    options.maxTokens === undefined ? undefined : "maxTokens",
    options.stop === undefined ? undefined : "stop",
  ].filter((field): field is string => field !== undefined);
  if (unsupported.length > 0) {
    throw new Error(
      `The model transport cannot represent DSH options: ${unsupported.join(", ")}.`,
    );
  }
}

function requireOpenBlock<TType extends OpenBlock["type"]>(
  blocks: Map<number, OpenBlock>,
  index: number,
  type: TType,
): Extract<OpenBlock, { type: TType }> {
  const block = blocks.get(index);
  if (!block || block.type !== type) {
    throw new Error(`No open ${type} block at index ${index}.`);
  }
  return block as Extract<OpenBlock, { type: TType }>;
}

function toFinishReason(
  event: Extract<ModelStreamEvent, { type: "done" }>,
  completedToolCalls: number,
): { kind: "stop" } | { kind: "tool-calls" } | { kind: "max-tokens" } {
  if (event.stop_reason === "length") return { kind: "max-tokens" };
  if (event.stop_reason === "tool_use" || completedToolCalls > 0) {
    return { kind: "tool-calls" };
  }
  return { kind: "stop" };
}

function unresolvedModel(
  provider: string,
  model: string,
): LlmResolvedModelInfo {
  return {
    provider,
    id: model,
    name: model,
    inputModalities: ["text"],
  };
}

function toLlmModelInfo(descriptor: ModelDescriptor): LlmModelInfo {
  return {
    provider: descriptor.provider_id,
    id: descriptor.model_id,
    name: descriptor.display_name,
    inputModalities: ["text"],
  };
}

function toResolvedModelInfo(
  descriptor: ModelDescriptor,
): LlmResolvedModelInfo {
  const efforts = descriptor.reasoning_efforts.map((effort) => ({
    id: ReasoningEffortId(effort),
    name: reasoningEffortName(effort),
  }));
  return {
    ...toLlmModelInfo(descriptor),
    ...(descriptor.context_window === null
      ? {}
      : { context: { contextWindow: descriptor.context_window } }),
    ...(efforts.length === 0 ? {} : { reasoning: { efforts } }),
  };
}

function reasoningEffortName(effort: ModelReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function createAbortError(): DOMException {
  return new DOMException("The model request was aborted.", "AbortError");
}
