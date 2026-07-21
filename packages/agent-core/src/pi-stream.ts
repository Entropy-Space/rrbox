import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  ModelConversationMessage,
  ModelRequest,
  ModelToolDefinition,
  ModelToolName,
  ModelTransport,
} from "@researchbox/model-transport";
import { assertCompleteToolCallResults } from "./tool-transcript.ts";

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
      request = toModelRequest(model, context, options?.sessionId);
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
  let textIndex: number | null = null;
  let sawToolCall = false;
  let providerStopReason: "stop" | "length" | "tool_use" | undefined;

  try {
    for await (const event of transport.stream(request, signal)) {
      if (event.type === "text_delta") {
        if (textIndex === null) {
          textIndex = message.content.length;
          message.content.push({ type: "text", text: "" });
          stream.push({
            type: "text_start",
            contentIndex: textIndex,
            partial: message,
          });
        }
        const block = message.content[textIndex];
        if (!block || block.type !== "text") {
          throw new Error("Invalid Pi text stream state.");
        }
        block.text += event.text_delta;
        stream.push({
          type: "text_delta",
          contentIndex: textIndex,
          delta: event.text_delta,
          partial: message,
        });
      } else if (event.type === "tool_call") {
        sawToolCall = true;
        const contentIndex = message.content.length;
        const toolCall = {
          type: "toolCall" as const,
          id: event.tool_call_id,
          name: event.tool_name,
          arguments: event.arguments,
        };
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        message.content.push(toolCall);
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall,
          partial: message,
        });
      } else {
        providerStopReason = event.stop_reason;
      }
    }

    if (textIndex !== null) {
      const block = message.content[textIndex];
      if (block?.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: textIndex,
          content: block.text,
          partial: message,
        });
      }
    }

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

function toModelRequest(
  model: Model<string>,
  context: Context,
  sessionId?: string,
): ModelRequest {
  assertCompleteToolCallResults(context.messages);
  return {
    session_id: sessionId ?? crypto.randomUUID(),
    provider_id: model.provider,
    model_id: model.id,
    system_prompt: context.systemPrompt ?? "",
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

  const toolCalls = message.content
    .filter(
      (block) => block.type === "toolCall" && isModelToolName(block.name),
    )
    .map((block) => {
      if (block.type !== "toolCall" || !isModelToolName(block.name)) {
        throw new Error("Invalid model tool call.");
      }
      const path = block.arguments.path;
      if (typeof path !== "string") {
        throw new Error(`Tool call ${block.id} is missing a path argument.`);
      }
      return {
        tool_call_id: block.id,
        tool_name: block.name,
        arguments: { path },
      };
    });
  const content = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return content || toolCalls.length > 0
    ? { role: "assistant", content, tool_calls: toolCalls }
    : null;
}

function isModelToolName(value: string): value is ModelToolName {
  return value === "list_files" || value === "read_file";
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
