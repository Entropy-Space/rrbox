import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import {
  isModelToolName,
  ModelStreamEventSequenceValidator,
  parseModelToolCall,
  type ModelAssistantContentBlock,
  type ModelConversationMessage,
  type ModelRequest,
  type ModelToolDefinition,
  type ModelTransport,
} from "@researchbox/model-transport";
import { assertCompleteToolCallResults } from "./tool-transcript.ts";

type ReasoningEffortModel = Model<string> & {
  supports_reasoning_effort?: boolean;
};

export function createModelStreamFn(transport: ModelTransport): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = createPartialMessage(model.api, model.provider, model.id);
    const signal = options?.signal ?? new AbortController().signal;
    stream.push({ type: "start", partial: message });

    if (signal.aborted) {
      message.stopReason = "aborted";
      message.errorMessage = "The model request was aborted.";
      stream.push({
        type: "error",
        reason: "aborted",
        error: message,
      });
      return stream;
    }

    let request: ModelRequest;
    try {
      request = toModelRequest(
        model,
        context,
        options?.sessionId,
        options?.reasoning,
      );
    } catch (error) {
      message.stopReason = "error";
      message.errorMessage =
        error instanceof Error ? error.message : "The model request is invalid.";
      stream.push({
        type: "error",
        reason: "error",
        error: message,
      });
      return stream;
    }

    void pumpModelStream(
      transport,
      request,
      signal,
      message,
      stream,
    );
    return stream;
  };
}

async function pumpModelStream(
  transport: ModelTransport,
  request: ModelRequest,
  signal: AbortSignal,
  message: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<void> {
  let sawToolCall = false;
  let providerStopReason: "stop" | "length" | "tool_use" | undefined;
  const validator = new ModelStreamEventSequenceValidator();
  const completedToolCallIndexes = new Set<number>();

  try {
    for await (const candidate of transport.stream(request, signal)) {
      const event = validator.accept(candidate);
      switch (event.type) {
        case "text_start":
          assertNextContentIndex(message, event.content_index);
          message.content.push({ type: "text", text: "" });
          stream.push({
            type: "text_start",
            contentIndex: event.content_index,
            partial: message,
          });
          break;
        case "text_delta": {
          const block = requireContentBlock(
            message,
            event.content_index,
            "text",
          );
          block.text += event.text_delta;
          stream.push({
            type: "text_delta",
            contentIndex: event.content_index,
            delta: event.text_delta,
            partial: message,
          });
          break;
        }
        case "text_end": {
          const block = requireContentBlock(
            message,
            event.content_index,
            "text",
          );
          stream.push({
            type: "text_end",
            contentIndex: event.content_index,
            content: block.text,
            partial: message,
          });
          break;
        }
        case "reasoning_start":
          assertNextContentIndex(message, event.content_index);
          message.content.push({ type: "thinking", thinking: "" });
          stream.push({
            type: "thinking_start",
            contentIndex: event.content_index,
            partial: message,
          });
          break;
        case "reasoning_delta": {
          const block = requireContentBlock(
            message,
            event.content_index,
            "thinking",
          );
          block.thinking += event.reasoning_delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: event.content_index,
            delta: event.reasoning_delta,
            partial: message,
          });
          break;
        }
        case "reasoning_end": {
          const block = requireContentBlock(
            message,
            event.content_index,
            "thinking",
          );
          stream.push({
            type: "thinking_end",
            contentIndex: event.content_index,
            content: block.thinking,
            partial: message,
          });
          break;
        }
        case "tool_call_start":
          sawToolCall = true;
          assertNextContentIndex(message, event.content_index);
          message.content.push({
            type: "toolCall",
            id: "",
            name: "",
            arguments: {},
          });
          stream.push({
            type: "toolcall_start",
            contentIndex: event.content_index,
            partial: message,
          });
          break;
        case "tool_call_delta": {
          const block = requireContentBlock(
            message,
            event.content_index,
            "toolCall",
          );
          block.id += event.tool_call_id_delta ?? "";
          block.name += event.tool_name_delta ?? "";
          stream.push({
            type: "toolcall_delta",
            contentIndex: event.content_index,
            delta: event.arguments_delta ?? "",
            partial: message,
          });
          break;
        }
        case "tool_call_end": {
          const block = requireContentBlock(
            message,
            event.content_index,
            "toolCall",
          );
          const toolCall = {
            type: "toolCall" as const,
            id: event.tool_call.tool_call_id,
            name: event.tool_call.tool_name,
            arguments: structuredClone(event.tool_call.arguments),
          };
          Object.assign(block, toolCall);
          completedToolCallIndexes.add(event.content_index);
          stream.push({
            type: "toolcall_end",
            contentIndex: event.content_index,
            toolCall,
            partial: message,
          });
          break;
        }
        case "done":
          providerStopReason = event.stop_reason;
          break;
      }
    }
    validator.assertComplete();

    message.stopReason =
      providerStopReason === "length"
        ? "length"
        : providerStopReason === "tool_use" || sawToolCall
          ? "toolUse"
          : "stop";
    stream.push({
      type: "done",
      reason: message.stopReason,
      message,
    });
  } catch (error) {
    message.content = message.content.filter(
      (block, contentIndex) =>
        block.type !== "toolCall" ||
        completedToolCallIndexes.has(contentIndex),
    );
    const aborted = signal.aborted;
    message.stopReason = aborted ? "aborted" : "error";
    message.errorMessage =
      error instanceof Error ? error.message : "The model stream failed.";
    stream.push({
      type: "error",
      reason: message.stopReason,
      error: message,
    });
  }
}

function assertNextContentIndex(
  message: AssistantMessage,
  contentIndex: number,
): void {
  if (contentIndex !== message.content.length) {
    throw new Error(
      `Expected model content_index ${message.content.length}, received ${contentIndex}.`,
    );
  }
}

function requireContentBlock<TType extends AssistantMessage["content"][number]["type"]>(
  message: AssistantMessage,
  contentIndex: number,
  type: TType,
): Extract<AssistantMessage["content"][number], { type: TType }> {
  const block = message.content[contentIndex];
  if (!block || block.type !== type) {
    throw new Error(
      `Invalid Pi ${type} stream state at content_index ${contentIndex}.`,
    );
  }
  return block as Extract<
    AssistantMessage["content"][number],
    { type: TType }
  >;
}

function toModelRequest(
  model: Model<string>,
  context: Context,
  sessionId?: string,
  reasoningEffort?: ModelRequest["reasoning_effort"],
): ModelRequest {
  assertCompleteToolCallResults(context.messages);
  return {
    session_id: sessionId ?? crypto.randomUUID(),
    provider_id: model.provider,
    model_id: model.id,
    system_prompt: context.systemPrompt ?? "",
    ...(reasoningEffort !== undefined && supportsReasoningEffort(model)
      ? { reasoning_effort: reasoningEffort }
      : {}),
    messages: context.messages
      .map(toModelConversationMessage)
      .filter((message): message is ModelConversationMessage => message !== null),
    tools: (context.tools ?? []).flatMap((tool): ModelToolDefinition[] =>
      isModelToolName(tool.name)
        ? [
            {
              name: tool.name,
              description: tool.description,
              parameters: structuredClone(tool.parameters),
            },
          ]
        : [],
    ),
  };
}

function supportsReasoningEffort(model: Model<string>): boolean {
  return (
    (model as ReasoningEffortModel).supports_reasoning_effort === true
  );
}

function toModelConversationMessage(
  message: Message,
): ModelConversationMessage | null {
  if (message.role === "user") {
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
    };
  }
  if (message.role === "toolResult") {
    if (!isModelToolName(message.toolName)) return null;
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      tool_name: message.toolName,
      content: message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      is_error: message.isError,
    };
  }

  const contentBlocks = message.content.flatMap(
    (block): ModelAssistantContentBlock[] => {
      switch (block.type) {
        case "text":
          return block.text ? [{ type: "text", text: block.text }] : [];
        case "thinking":
          return block.thinking
            ? [{ type: "reasoning", reasoning: block.thinking }]
            : [];
        case "toolCall":
          if (!isModelToolName(block.name)) {
            throw new Error("Invalid model tool call.");
          }
          return [
            {
              type: "tool_call",
              ...parseModelToolCall({
                tool_call_id: block.id,
                tool_name: block.name,
                arguments: block.arguments,
              }),
            },
          ];
      }
    },
  );
  return contentBlocks.length > 0
    ? { role: "assistant", content_blocks: contentBlocks }
    : null;
}

function createPartialMessage(
  api: string,
  provider: string,
  model: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
