import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  ModelRequest,
  ModelToolResult,
  ModelTransport,
} from "./model-transport";

export function createModelStreamFn(transport: ModelTransport): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = createPartialMessage(model.api, model.provider, model.id);
    stream.push({ type: "start", partial: message });

    void pumpModelStream(
      transport,
      toModelRequest(context, options?.sessionId),
      options?.signal ?? new AbortController().signal,
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

    message.stopReason = sawToolCall ? "toolUse" : "stop";
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

function toModelRequest(context: Context, sessionId?: string): ModelRequest {
  const lastUserIndex = context.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const userMessage = context.messages[lastUserIndex];
  const prompt =
    userMessage?.role === "user"
      ? typeof userMessage.content === "string"
        ? userMessage.content
        : userMessage.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
      : "";
  const toolResults = context.messages
    .slice(lastUserIndex + 1)
    .filter((message): message is ToolResultMessage => message.role === "toolResult")
    .map(toModelToolResult);

  return {
    session_id: sessionId ?? crypto.randomUUID(),
    prompt,
    tool_results: toolResults,
  };
}

function toModelToolResult(message: ToolResultMessage): ModelToolResult {
  const toolName =
    message.toolName === "read_file" ? "read_file" : "list_files";
  return {
    tool_call_id: message.toolCallId,
    tool_name: toolName,
    content: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    is_error: message.isError,
  };
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
