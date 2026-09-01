import {
  CallId,
  MessageId,
  freezeMessage,
  type AssistantMessage,
  type ContentBlock,
  type ToolResultMessage,
} from "@deepseek-ai/dsh-llm";
import {
  TOOL_OUTCOME_UNKNOWN,
  type SessionEvent,
  type TurnEndReason,
} from "@deepseek-ai/dsh-session";
import type { LegacySessionDocument } from "@researchbox/project-store";
import type {
  AssistantBlock,
  AssistantMessageEntry,
  TimelineEntry,
  ToolResultEntry,
  UserMessageEntry,
} from "@researchbox/protocol";

const LEGACY_REPLAY_STATE_KIND = "researchbox_timeline_v5";

/** Convert the active legacy branch into a complete, deterministic DSH seed. */
export function legacyTimelineToDshSeed(
  document: LegacySessionDocument,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const runs = groupRuns(document.timeline);

  for (const [runIndex, run] of runs.entries()) {
    appendRun(events, run, runIndex + 1);
  }
  return events;
}

function appendRun(
  events: SessionEvent[],
  run: readonly TimelineEntry[],
  turn: number,
): void {
  const user = run[0];
  if (user?.type !== "user_message") {
    throw new Error(`Legacy run ${turn} does not start with a user message.`);
  }
  const userTime = timestamp(user.created_at);
  append(events, "turn/start", userTime, { turn });

  let step = 1;
  append(events, "step/start", userTime, { turn, step });
  appendSurface(events, "user/message", userTime, toUserMessage(user));

  let index = 1;
  let lastAssistant: AssistantMessageEntry | undefined;
  while (index < run.length) {
    const assistant = run[index];
    if (assistant?.type !== "assistant_message") {
      throw new Error(
        `Legacy run ${turn} has a tool result without an assistant message.`,
      );
    }
    if (assistant.status === "streaming") {
      throw new Error("A streaming legacy response cannot be migrated.");
    }
    lastAssistant = assistant;
    const assistantTime = timestamp(assistant.created_at);
    append(events, "request/context", assistantTime, {
      provider: assistant.provider,
      model: assistant.model,
    });
    appendSurface(
      events,
      "assistant/message",
      assistantTime,
      {
        turn,
        step,
        message: toAssistantMessage(assistant),
        usage: {
          inputTokens: assistant.usage.input,
          outputTokens: assistant.usage.output,
          ...(assistant.usage.cache_read === 0
            ? {}
            : { cacheReadTokens: assistant.usage.cache_read }),
          ...(assistant.usage.cache_write === 0
            ? {}
            : { cacheWriteTokens: assistant.usage.cache_write }),
        },
        ...(assistant.status === "aborted" ? { interrupted: true as const } : {}),
      },
    );

    const calls = assistant.blocks.filter(
      (block): block is Extract<AssistantBlock, { type: "tool_call" }> =>
        block.type === "tool_call",
    );
    for (const call of calls) {
      append(events, "tool/call", assistantTime, {
        turn,
        step,
        callId: CallId(call.tool_call_id),
        name: call.tool_name,
        arguments: JSON.stringify(call.arguments),
      });
    }

    index += 1;
    const resolved = new Set<string>();
    let stepEndTime = assistantTime;
    while (index < run.length && run[index]?.type === "tool_result") {
      const result = run[index] as ToolResultEntry;
      if (!calls.some((call) => call.block_id === result.tool_call_block_id)) {
        throw new Error(
          `Legacy tool result ${result.entry_id} does not belong to its assistant step.`,
        );
      }
      if (resolved.has(result.tool_call_block_id)) {
        throw new Error(
          `Legacy tool call ${result.tool_call_id} has duplicate results.`,
        );
      }
      resolved.add(result.tool_call_block_id);
      stepEndTime = timestamp(result.created_at);
      appendSurface(
        events,
        "tool/result",
        stepEndTime,
        {
          turn,
          step,
          message: toToolResultMessage(result),
          ...(result.is_error
            ? {
                error: {
                  name: "LegacyToolError",
                  code: "LEGACY_TOOL_ERROR",
                },
              }
            : {}),
          ...(result.summary === undefined && result.file_change === undefined
            ? {}
            : {
                meta: {
                  ...(result.summary === undefined
                    ? {}
                    : { summary: result.summary }),
                  ...(result.file_change === undefined
                    ? {}
                    : { file_change: result.file_change }),
                },
              }),
        },
      );
      index += 1;
    }
    for (const call of calls) {
      if (resolved.has(call.block_id)) continue;
      appendSurface(
        events,
        "tool/result",
        stepEndTime,
        {
          turn,
          step,
          message: toInterruptedToolResultMessage(assistant, call),
          error: {
            name: "LegacyToolOutcomeUnknown",
            code: TOOL_OUTCOME_UNKNOWN,
          },
          meta: { summary: "Tool execution was interrupted" },
        },
      );
    }

    append(events, "step/end", stepEndTime, { turn, step });
    if (index < run.length) {
      step += 1;
      append(events, "step/start", timestamp(run[index]!.created_at), {
        turn,
        step,
      });
    }
  }

  if (lastAssistant === undefined) {
    append(events, "step/end", userTime, { turn, step });
  }
  append(
    events,
    "turn/end",
    timestamp(run.at(-1)!.created_at),
    { turn, reason: turnEndReason(lastAssistant) },
  );
}

function groupRuns(
  timeline: readonly TimelineEntry[],
): TimelineEntry[][] {
  const runs: TimelineEntry[][] = [];
  for (const entry of timeline) {
    const current = runs.at(-1);
    if (current?.[0]?.run_id === entry.run_id) {
      current.push(entry);
    } else {
      runs.push([entry]);
    }
  }
  return runs;
}

function toUserMessage(entry: UserMessageEntry) {
  return freezeMessage({
    id: MessageId(`legacy:${entry.entry_id}`),
    role: "user" as const,
    content: [{ type: "text" as const, text: entry.content }],
    source: { kind: "user" as const },
  });
}

function toAssistantMessage(
  entry: AssistantMessageEntry,
): AssistantMessage {
  return freezeMessage({
    id: MessageId(`legacy:${entry.entry_id}`),
    role: "assistant",
    content: entry.blocks.map(toContentBlock),
    source: {
      kind: "model",
      provider: entry.provider,
      model: entry.model,
      replayState: {
        dshrbox_import: {
          kind: LEGACY_REPLAY_STATE_KIND,
          api: entry.api,
          status: entry.status,
          usage: entry.usage,
          blocks: entry.blocks,
          ...(entry.response_model === undefined
            ? {}
            : { response_model: entry.response_model }),
          ...(entry.response_id === undefined
            ? {}
            : { response_id: entry.response_id }),
          ...(entry.stop_reason === undefined
            ? {}
            : { stop_reason: entry.stop_reason }),
          ...(entry.error_message === undefined
            ? {}
            : { error_message: entry.error_message }),
        },
      },
    },
  });
}

function toContentBlock(block: AssistantBlock): ContentBlock {
  switch (block.type) {
    case "assistant_text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool_call":
      return {
        type: "tool-call",
        id: CallId(block.tool_call_id),
        name: block.tool_name,
        arguments: JSON.stringify(block.arguments),
      };
  }
}

function toToolResultMessage(entry: ToolResultEntry): ToolResultMessage {
  const callId = CallId(entry.tool_call_id);
  return freezeMessage({
    id: MessageId(`legacy:${entry.entry_id}`),
    role: "user",
    content: [{
      type: "tool-result",
      toolCallId: callId,
      content: [{ type: "text", text: entry.content }],
      ...(entry.is_error ? { isError: true } : {}),
    }],
    source: { kind: "tool", callId },
  });
}

function toInterruptedToolResultMessage(
  assistant: AssistantMessageEntry,
  call: Extract<AssistantBlock, { type: "tool_call" }>,
): ToolResultMessage {
  const callId = CallId(call.tool_call_id);
  return freezeMessage({
    id: MessageId(
      `legacy:unresolved:${assistant.entry_id}:${call.block_id}`,
    ),
    role: "user",
    content: [{
      type: "tool-result",
      toolCallId: callId,
      content: [{
        type: "text",
        text: "The legacy tool execution ended without a recorded result.",
      }],
      isError: true,
    }],
    source: { kind: "tool", callId },
  });
}

function turnEndReason(
  assistant: AssistantMessageEntry | undefined,
): TurnEndReason {
  if (assistant?.status === "aborted") {
    return { kind: "aborted", reason: { kind: "legacy" } };
  }
  if (assistant?.status === "error") {
    return {
      kind: "error",
      error: {
        message: assistant.error_message ?? "Legacy model request failed.",
        code: "LEGACY_IMPORT",
      },
    };
  }
  if (assistant?.stop_reason === "length") return { kind: "max-tokens" };
  return { kind: "completed" };
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid legacy timeline timestamp: ${value}.`);
  }
  return parsed;
}

function append<TType extends SessionEvent["type"]>(
  events: SessionEvent[],
  type: TType,
  time: number,
  data: Extract<SessionEvent, { type: TType }>["data"],
): void {
  events.push({ type, seq: events.length, time, data } as SessionEvent);
}

function appendSurface<
  TType extends "user/message" | "assistant/message" | "tool/result",
>(
  events: SessionEvent[],
  type: TType,
  time: number,
  data: Extract<SessionEvent, { type: TType }>["data"],
): void {
  events.push({
    type,
    seq: events.length,
    time,
    data,
    surfaceOp: "append",
  } as SessionEvent);
}
