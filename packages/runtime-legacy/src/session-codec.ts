import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  AssistantBlock,
  AssistantMessageEntry,
  AssistantStopReason,
  AssistantUsage,
  TimelineEntry,
  ToolResultEntry,
} from "@researchbox/protocol";
import { emptyAssistantUsage } from "@researchbox/protocol";

export function timelineToAgentMessages(
  timeline: readonly TimelineEntry[],
): AgentMessage[] {
  return timeline.map((entry): Message => {
    switch (entry.type) {
      case "user_message":
        return {
          role: "user",
          content: entry.content,
          timestamp: parseTimestamp(entry.created_at),
        };
      case "assistant_message":
        if (entry.status === "streaming") {
          throw new Error(
            "A streaming assistant entry cannot be restored into the agent transcript.",
          );
        }
        return {
          role: "assistant",
          content: entry.blocks.map(toAgentAssistantBlock),
          api: entry.api,
          provider: entry.provider,
          model: entry.model,
          ...(entry.response_model === undefined
            ? {}
            : { responseModel: entry.response_model }),
          ...(entry.response_id === undefined
            ? {}
            : { responseId: entry.response_id }),
          usage: {
            input: entry.usage.input,
            output: entry.usage.output,
            cacheRead: entry.usage.cache_read,
            cacheWrite: entry.usage.cache_write,
            totalTokens: entry.usage.total_tokens,
            cost: {
              input: entry.usage.cost.input,
              output: entry.usage.cost.output,
              cacheRead: entry.usage.cost.cache_read,
              cacheWrite: entry.usage.cost.cache_write,
              total: entry.usage.cost.total,
            },
          },
          stopReason: fromTimelineStopReason(
            entry.stop_reason ?? stopReasonForStatus(entry.status),
          ),
          ...(entry.error_message === undefined
            ? {}
            : { errorMessage: entry.error_message }),
          timestamp: parseTimestamp(entry.created_at),
        };
      case "tool_result":
        return {
          role: "toolResult",
          toolCallId: entry.tool_call_id,
          toolName: entry.tool_name,
          content: [{ type: "text", text: entry.content }],
          details: toolResultDetails(entry),
          isError: entry.is_error,
          timestamp: parseTimestamp(entry.created_at),
        };
    }
  });
}

export function createStreamingAssistantEntry(
  message: AssistantMessage,
  runId: string,
): AssistantMessageEntry {
  return {
    type: "assistant_message",
    entry_id: crypto.randomUUID(),
    run_id: runId,
    created_at: toIsoTimestamp(message.timestamp),
    status: "streaming",
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: emptyAssistantUsage(),
    blocks: [],
  };
}

export function finalizeAssistantEntry(
  entry: AssistantMessageEntry,
  message: AssistantMessage,
): AssistantMessageEntry {
  const base = { ...entry };
  delete base.response_model;
  delete base.response_id;
  delete base.error_message;
  const blocks = message.content.map((content, index) =>
    toTimelineAssistantBlock(content, entry.blocks[index]),
  );
  return {
    ...base,
    status: assistantStatus(message.stopReason),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel === undefined
      ? {}
      : { response_model: message.responseModel }),
    ...(message.responseId === undefined
      ? {}
      : { response_id: message.responseId }),
    usage: toTimelineUsage(message),
    stop_reason: toTimelineStopReason(message.stopReason),
    ...(message.errorMessage === undefined
      ? {}
      : { error_message: message.errorMessage }),
    blocks,
  };
}

export function createToolResultEntry(
  message: ToolResultMessage,
  runId: string,
  toolCallBlockId: string,
): ToolResultEntry {
  const details = isRecord(message.details) ? message.details : undefined;
  const summary =
    typeof details?.summary === "string" ? details.summary : undefined;
  const fileChange = isWorkspaceChangeSummary(
    details?.file_change,
    message.toolCallId,
    message.toolName,
  )
    ? structuredClone(details.file_change)
    : undefined;
  return {
    type: "tool_result",
    entry_id: crypto.randomUUID(),
    run_id: runId,
    created_at: toIsoTimestamp(message.timestamp),
    tool_call_block_id: toolCallBlockId,
    tool_call_id: message.toolCallId,
    tool_name: message.toolName,
    content: message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n"),
    is_error: message.isError,
    ...(summary === undefined ? {} : { summary }),
    ...(fileChange === undefined ? {} : { file_change: fileChange }),
  };
}

function toAgentAssistantBlock(
  block: AssistantBlock,
): AssistantMessage["content"][number] {
  switch (block.type) {
    case "assistant_text":
      return {
        type: "text",
        text: block.text,
        ...(block.text_signature === undefined
          ? {}
          : { textSignature: block.text_signature }),
      };
    case "reasoning":
      return {
        type: "thinking",
        thinking: block.text,
        ...(block.thinking_signature === undefined
          ? {}
          : { thinkingSignature: block.thinking_signature }),
        ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
      };
    case "tool_call":
      return {
        type: "toolCall",
        id: block.tool_call_id,
        name: block.tool_name,
        arguments: structuredClone(block.arguments),
        ...(block.thought_signature === undefined
          ? {}
          : { thoughtSignature: block.thought_signature }),
      };
  }
}

function toTimelineAssistantBlock(
  content: AssistantMessage["content"][number],
  existing: AssistantBlock | undefined,
): AssistantBlock {
  const blockId = existing?.block_id ?? crypto.randomUUID();
  switch (content.type) {
    case "text":
      return {
        type: "assistant_text",
        block_id: blockId,
        text: content.text,
        ...(content.textSignature === undefined
          ? {}
          : { text_signature: content.textSignature }),
      };
    case "thinking":
      return {
        type: "reasoning",
        block_id: blockId,
        text: content.thinking,
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
        block_id: blockId,
        tool_call_id: content.id,
        tool_name: content.name,
        arguments: structuredClone(content.arguments),
        ...(content.thoughtSignature === undefined
          ? {}
          : { thought_signature: content.thoughtSignature }),
        ...(existing?.type === "tool_call" && existing.label !== undefined
          ? { label: existing.label }
          : {}),
        ...(existing?.type === "tool_call" &&
            existing.progress_summary !== undefined
          ? { progress_summary: existing.progress_summary }
          : {}),
      };
  }
}

function toTimelineUsage(message: AssistantMessage): AssistantUsage {
  return {
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
  };
}

function assistantStatus(
  stopReason: AssistantMessage["stopReason"],
): AssistantMessageEntry["status"] {
  if (stopReason === "aborted") return "aborted";
  if (stopReason === "error") return "error";
  return "complete";
}

function toTimelineStopReason(
  stopReason: AssistantMessage["stopReason"],
): AssistantStopReason {
  return stopReason === "toolUse" ? "tool_use" : stopReason;
}

function fromTimelineStopReason(
  stopReason: AssistantStopReason,
): AssistantMessage["stopReason"] {
  return stopReason === "tool_use" ? "toolUse" : stopReason;
}

function stopReasonForStatus(
  status: Exclude<AssistantMessageEntry["status"], "streaming">,
): AssistantStopReason {
  if (status === "aborted") return "aborted";
  if (status === "error") return "error";
  return "stop";
}

function toolResultDetails(
  entry: ToolResultEntry,
): Record<string, unknown> {
  return {
    ...(entry.summary === undefined ? {} : { summary: entry.summary }),
    ...(entry.file_change === undefined
      ? {}
      : { file_change: structuredClone(entry.file_change) }),
  };
}

function isWorkspaceChangeSummary(
  value: unknown,
  expectedToolCallId: string,
  expectedToolName: string,
): value is NonNullable<ToolResultEntry["file_change"]> {
  if (!isRecord(value)) return false;
  const changeKind = value.change_kind;
  const toolName = value.tool_name;
  const toolMatchesChangeKind =
    (toolName === "write_file" &&
      (changeKind === "created" || changeKind === "updated")) ||
    (toolName === "replace_text" && changeKind === "updated") ||
    (toolName === "remove_file" && changeKind === "deleted");
  return (
    typeof value.change_id === "string" &&
    value.tool_call_id === expectedToolCallId &&
    toolName === expectedToolName &&
    (toolName === "write_file" ||
      toolName === "replace_text" ||
      toolName === "remove_file") &&
    typeof value.path === "string" &&
    (changeKind === "created" ||
      changeKind === "updated" ||
      changeKind === "deleted") &&
    toolMatchesChangeKind &&
    isNonNegativeInteger(value.additions) &&
    isNonNegativeInteger(value.deletions) &&
    isNonNegativeInteger(value.byte_size)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Timeline entry created_at must be a valid timestamp.");
  }
  return timestamp;
}

function toIsoTimestamp(value: number): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Agent message timestamp must be finite.");
  }
  return timestamp.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
