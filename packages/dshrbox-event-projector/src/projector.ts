import type {
  ContentBlock,
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
} from "@deepseek-ai/dsh-llm";
import type {
  SessionEvent,
  TurnEndReason,
} from "@deepseek-ai/dsh-session";
import { dshrboxToolCallBlockId } from "@dshrbox/core/identity";
import {
  emptyAssistantUsage,
  parseWorkspaceChangeSummary,
  PROTOCOL_VERSION,
  type AssistantBlock,
  type AssistantMessageEntry,
  type AssistantUsage,
  type CoreEvent,
  type TimelineEntry,
  type ToolCallBlock as TimelineToolCallBlock,
  type ToolResultEntry,
  type WorkspaceChangeSummary,
} from "@researchbox/protocol";

export type DshrboxEventProjectorOptions = {
  api?: string;
  project_id: string;
  session_id: string;
};

export type DshrboxProjectionSnapshot = {
  is_running: boolean;
  last_event_seq: number | null;
  timeline: TimelineEntry[];
};

type Route = {
  model: string;
  provider: string;
};

type OpenBlock =
  | {
      type: "text";
      block_id: string;
    }
  | {
      type: "reasoning";
      block_id: string;
    }
  | {
      type: "tool-call";
      arguments_json: string;
      call_id?: string;
      name?: string;
    };

type AssistantProjection = {
  entry: AssistantMessageEntry;
  open_blocks: Map<number, OpenBlock>;
  step: number;
  turn: number;
};

type ProjectedToolCall = {
  arguments: Record<string, unknown>;
  block_id: string;
  name: string;
};

/** Pure, deterministic DSH-session to rrbox-timeline projection. */
export class DshrboxEventProjector {
  private readonly api: string;
  private readonly projectId: string;
  private readonly sessionId: string;
  private readonly timeline: TimelineEntry[] = [];
  private readonly timelineIndexes = new Map<string, number>();
  private readonly assistants = new Map<string, AssistantProjection>();
  private readonly toolCalls = new Map<string, ProjectedToolCall>();
  private activeTurn: number | null = null;
  private latestRoute: Route | null = null;
  private running = false;
  private lastEventSeq: number | null = null;
  private lastEventFingerprint: string | null = null;

  constructor(options: DshrboxEventProjectorOptions) {
    this.projectId = requireIdentifier(options.project_id, "project_id");
    this.sessionId = requireIdentifier(options.session_id, "session_id");
    this.api = options.api === undefined
      ? "dsh"
      : requireIdentifier(options.api, "api");
  }

  get last_event_seq(): number | null {
    return this.lastEventSeq;
  }

  accept(event: SessionEvent): CoreEvent[] {
    this.assertNextEvent(event);
    const fingerprint = JSON.stringify(event);
    if (event.seq === this.lastEventSeq) {
      if (fingerprint !== this.lastEventFingerprint) {
        throw new Error(`Conflicting DSH event at seq ${event.seq}.`);
      }
      return [];
    }

    const projected: CoreEvent[] = [];
    this.projectEvent(event, projected);
    this.lastEventSeq = event.seq;
    this.lastEventFingerprint = fingerprint;
    return projected;
  }

  replay(events: readonly SessionEvent[]): DshrboxProjectionSnapshot {
    for (const event of events) this.accept(event);
    return this.snapshot();
  }

  snapshot(): DshrboxProjectionSnapshot {
    return {
      is_running: this.running,
      last_event_seq: this.lastEventSeq,
      timeline: structuredClone(this.timeline),
    };
  }

  private projectEvent(event: SessionEvent, projected: CoreEvent[]): void {
    if (isReplacementSurfaceEvent(event)) return;

    switch (event.type) {
      case "turn/start":
        this.activeTurn = event.data.turn;
        this.running = true;
        projected.push(this.coreEvent(
          event,
          "run-start",
          "run_state",
          { ...this.scope(), is_running: true },
        ));
        break;
      case "turn/end":
        this.finishTurn(event, projected);
        this.activeTurn = null;
        this.running = false;
        projected.push(this.coreEvent(
          event,
          "run-end",
          "run_state",
          { ...this.scope(), is_running: false },
        ));
        break;
      case "request/header":
        this.latestRoute = {
          provider: event.data.header.config.provider,
          model: event.data.header.config.model,
        };
        break;
      case "request/context":
        this.latestRoute = {
          provider: event.data.provider,
          model: event.data.model,
        };
        break;
      case "user/message":
        this.projectUserMessage(event, projected);
        break;
      case "assistant/chunk":
        this.projectAssistantChunk(event, projected);
        break;
      case "assistant/message":
        this.projectAssistantMessage(event, projected);
        break;
      case "tool/call":
        this.projectToolCall(event, projected);
        break;
      case "tool/result":
        this.projectToolResult(event, projected);
        break;
      default:
        break;
    }
  }

  private projectUserMessage(
    event: Extract<SessionEvent, { type: "user/message" }>,
    projected: CoreEvent[],
  ): void {
    if (event.data.source.kind !== "user") return;
    const turn = this.requireActiveTurn();
    this.appendEntry({
      type: "user_message",
      entry_id: this.messageEntryId(String(event.data.id)),
      run_id: this.runId(turn),
      created_at: eventTimestamp(event),
      content: textContent(event.data.content, "DSH user message"),
    }, event, "user-message", projected);
  }

  private projectAssistantChunk(
    event: Extract<SessionEvent, { type: "assistant/chunk" }>,
    projected: CoreEvent[],
  ): void {
    const chunk = event.data.chunk;
    if (chunk.type === "block-start") {
      this.startBlock(event, chunk, projected);
      return;
    }

    const assistant = this.ensureAssistant(
      event.data.turn,
      event.data.step,
      event.time,
      undefined,
      event,
      projected,
    );
    switch (chunk.type) {
      case "text-delta":
        this.appendTextDelta(
          assistant,
          chunk.index,
          "text",
          chunk.text,
          event,
          projected,
        );
        break;
      case "reasoning-delta":
        this.appendTextDelta(
          assistant,
          chunk.index,
          "reasoning",
          chunk.text,
          event,
          projected,
        );
        break;
      case "tool-call-delta":
        this.appendToolCallDelta(assistant, chunk);
        break;
      case "block-end":
        this.endBlock(assistant, chunk, event, projected);
        break;
      case "usage":
        assistant.entry.usage = toAssistantUsage(chunk.usage);
        this.updateEntry(
          assistant.entry,
          event,
          `assistant-${event.data.step}-usage`,
          projected,
        );
        break;
      case "finish":
        applyFinishReason(assistant.entry, chunk.reason);
        this.updateEntry(
          assistant.entry,
          event,
          `assistant-${event.data.step}-finish`,
          projected,
        );
        break;
    }
  }

  private startBlock(
    event: Extract<SessionEvent, { type: "assistant/chunk" }>,
    chunk: Extract<StreamChunk, { type: "block-start" }>,
    projected: CoreEvent[],
  ): void {
    if (chunk.blockType !== "text" && chunk.blockType !== "reasoning" &&
      chunk.blockType !== "tool-call") {
      throw new Error(
        `Unsupported DSH assistant block type: ${String(chunk.blockType)}.`,
      );
    }
    const assistant = this.ensureAssistant(
      event.data.turn,
      event.data.step,
      event.time,
      undefined,
      event,
      projected,
    );
    if (assistant.open_blocks.has(chunk.index)) {
      throw new Error(`DSH assistant block ${chunk.index} is already open.`);
    }
    if (chunk.blockType === "tool-call") {
      assistant.open_blocks.set(chunk.index, {
        type: "tool-call",
        arguments_json: "",
      });
      return;
    }

    const blockId = this.indexBlockId(
      event.data.turn,
      event.data.step,
      chunk.index,
    );
    const block: AssistantBlock = chunk.blockType === "text"
      ? { type: "assistant_text", block_id: blockId, text: "" }
      : { type: "reasoning", block_id: blockId, text: "" };
    assistant.open_blocks.set(chunk.index, {
      type: chunk.blockType,
      block_id: blockId,
    });
    assistant.entry.blocks.push(block);
    projected.push(this.coreEvent(
      event,
      `assistant-${event.data.step}-block-${chunk.index}-start`,
      "assistant_block_appended",
      {
        ...this.scope(),
        entry_id: assistant.entry.entry_id,
        block: structuredClone(block),
      },
    ));
  }

  private appendTextDelta(
    assistant: AssistantProjection,
    index: number,
    expectedType: "text" | "reasoning",
    textDelta: string,
    event: Extract<SessionEvent, { type: "assistant/chunk" }>,
    projected: CoreEvent[],
  ): void {
    const open = assistant.open_blocks.get(index);
    if (!open || open.type !== expectedType) {
      throw new Error(`No open DSH ${expectedType} block at index ${index}.`);
    }
    const block = requireAssistantBlock(assistant.entry, open.block_id);
    const blockType = expectedType === "text"
      ? "assistant_text"
      : "reasoning";
    if (block.type !== blockType) {
      throw new Error("DSH assistant block state is inconsistent.");
    }
    block.text += textDelta;
    projected.push(this.coreEvent(
      event,
      `assistant-${event.data.step}-block-${index}-delta`,
      "assistant_block_delta",
      {
        ...this.scope(),
        entry_id: assistant.entry.entry_id,
        block_id: block.block_id,
        block_type: blockType,
        text_delta: textDelta,
      },
    ));
  }

  private appendToolCallDelta(
    assistant: AssistantProjection,
    chunk: Extract<StreamChunk, { type: "tool-call-delta" }>,
  ): void {
    const open = assistant.open_blocks.get(chunk.index);
    if (!open || open.type !== "tool-call") {
      throw new Error(
        `No open DSH tool-call block at index ${chunk.index}.`,
      );
    }
    const callId = String(chunk.id);
    if (open.call_id !== undefined && open.call_id !== callId) {
      throw new Error("DSH tool-call delta changed its call id.");
    }
    if (
      chunk.name !== undefined &&
      open.name !== undefined &&
      open.name !== chunk.name
    ) {
      throw new Error("DSH tool-call delta changed its tool name.");
    }
    open.call_id = callId;
    if (chunk.name !== undefined) open.name = chunk.name;
    open.arguments_json += chunk.argumentsDelta;
  }

  private endBlock(
    assistant: AssistantProjection,
    chunk: Extract<StreamChunk, { type: "block-end" }>,
    event: Extract<SessionEvent, { type: "assistant/chunk" }>,
    projected: CoreEvent[],
  ): void {
    const open = assistant.open_blocks.get(chunk.index);
    if (!open) {
      throw new Error(`No open DSH block at index ${chunk.index}.`);
    }
    if (open.type === "text" || open.type === "reasoning") {
      const expectedBlockType = open.type;
      const projectedBlock = requireAssistantBlock(
        assistant.entry,
        open.block_id,
      );
      if (
        chunk.block.type !== expectedBlockType ||
        projectedBlock.type === "tool_call" ||
        chunk.block.text !== projectedBlock.text
      ) {
        throw new Error(
          `DSH ${expectedBlockType} block end does not match its deltas.`,
        );
      }
      assistant.open_blocks.delete(chunk.index);
      return;
    }

    if (chunk.block.type !== "tool-call") {
      throw new Error("DSH tool-call block ended with a different type.");
    }
    const callId = String(chunk.block.id);
    if (
      (open.call_id !== undefined && open.call_id !== callId) ||
      (open.name !== undefined && open.name !== chunk.block.name) ||
      open.arguments_json !== chunk.block.arguments
    ) {
      throw new Error("DSH tool-call block end does not match its deltas.");
    }
    assistant.open_blocks.delete(chunk.index);
    const block = this.toTimelineToolCall(
      chunk.block,
      assistant.turn,
      assistant.step,
    );
    this.registerToolCall(assistant.turn, assistant.step, block);
    if (!hasToolCallBlock(assistant.entry, block.tool_call_id)) {
      assistant.entry.blocks.push(block);
      projected.push(this.coreEvent(
        event,
        `assistant-${event.data.step}-block-${chunk.index}-tool-call`,
        "assistant_block_appended",
        {
          ...this.scope(),
          entry_id: assistant.entry.entry_id,
          block: structuredClone(block),
        },
      ));
    }
  }

  private projectAssistantMessage(
    event: Extract<SessionEvent, { type: "assistant/message" }>,
    projected: CoreEvent[],
  ): void {
    const blocks = event.data.message.content.map((block, index) =>
      this.toAssistantBlock(
        block,
        event.data.turn,
        event.data.step,
        index,
      )
    );
    const route = {
      provider: event.data.message.source.provider,
      model: event.data.message.source.model,
    };
    const assistant = this.ensureAssistant(
      event.data.turn,
      event.data.step,
      event.time,
      route,
      event,
      projected,
    );
    assistant.entry.provider = route.provider;
    assistant.entry.model = route.model;
    assistant.entry.blocks = blocks;
    assistant.open_blocks.clear();
    for (const block of blocks) {
      if (block.type === "tool_call") {
        this.registerToolCall(
          event.data.turn,
          event.data.step,
          block,
        );
      }
    }
    if (event.data.usage !== undefined) {
      assistant.entry.usage = toAssistantUsage(event.data.usage);
    }
    if (event.data.interrupted === true) {
      assistant.entry.status = "aborted";
      assistant.entry.stop_reason = "aborted";
      delete assistant.entry.error_message;
    } else if (assistant.entry.status === "streaming") {
      assistant.entry.status = "complete";
      assistant.entry.stop_reason = blocks.some(
        (block) => block.type === "tool_call",
      ) ? "tool_use" : "stop";
    }
    applyImportedAssistantMetadata(
      assistant.entry,
      event.data.message.source.replayState,
    );
    this.updateEntry(
      assistant.entry,
      event,
      `assistant-${event.data.step}-message`,
      projected,
    );
  }

  private projectToolCall(
    event: Extract<SessionEvent, { type: "tool/call" }>,
    projected: CoreEvent[],
  ): void {
    const callId = String(event.data.callId);
    const block: TimelineToolCallBlock = {
      type: "tool_call",
      block_id: this.toolCallBlockId(
        event.data.turn,
        event.data.step,
        callId,
      ),
      tool_call_id: callId,
      tool_name: event.data.name,
      arguments: parseArguments(event.data.arguments, event.data.name),
    };
    this.registerToolCall(event.data.turn, event.data.step, block);
    const assistant = this.ensureAssistant(
      event.data.turn,
      event.data.step,
      event.time,
      undefined,
      event,
      projected,
    );
    if (!hasToolCallBlock(assistant.entry, callId)) {
      assistant.entry.blocks.push(block);
      projected.push(this.coreEvent(
        event,
        `assistant-${event.data.step}-tool-${identitySegment(callId)}`,
        "assistant_block_appended",
        {
          ...this.scope(),
          entry_id: assistant.entry.entry_id,
          block: structuredClone(block),
        },
      ));
    }
    if (assistant.entry.status === "streaming") {
      assistant.entry.status = "complete";
      assistant.entry.stop_reason = "tool_use";
      this.updateEntry(
        assistant.entry,
        event,
        `assistant-${event.data.step}-tool-finish`,
        projected,
      );
    }
  }

  private projectToolResult(
    event: Extract<SessionEvent, { type: "tool/result" }>,
    projected: CoreEvent[],
  ): void {
    const resultBlock = event.data.message.content[0];
    if (resultBlock?.type !== "tool-result") {
      throw new Error("DSH tool result message has no result block.");
    }
    const callId = String(resultBlock.toolCallId);
    if (callId !== String(event.data.message.source.callId)) {
      throw new Error("DSH tool result source and block ids do not match.");
    }
    const call = this.toolCalls.get(toolCallKey(
      event.data.turn,
      event.data.step,
      callId,
    ));
    if (!call) {
      throw new Error(`DSH tool result has no projected call: ${callId}.`);
    }
    const metadata = projectToolResultMetadata(
      event.data.meta,
      callId,
      call.name,
    );
    if (
      metadata.file_change !== undefined &&
      metadata.workspace_revision !== undefined &&
      resultBlock.isError !== true &&
      event.data.error === undefined
    ) {
      projected.push(this.coreEvent(
        event,
        `tool-result-${identitySegment(callId)}-workspace-change`,
        "workspace_changed",
        {
          ...this.scope(),
          workspace_revision: metadata.workspace_revision,
          change: structuredClone(metadata.file_change),
        },
      ));
    }
    const entry: ToolResultEntry = {
      type: "tool_result",
      entry_id: this.messageEntryId(String(event.data.message.id)),
      run_id: this.runId(event.data.turn),
      created_at: eventTimestamp(event),
      tool_call_block_id: call.block_id,
      tool_call_id: callId,
      tool_name: call.name,
      content: textContent(resultBlock.content, "DSH tool result"),
      is_error: resultBlock.isError ?? event.data.error !== undefined,
      ...(metadata.summary === undefined
        ? {}
        : { summary: metadata.summary }),
      ...(metadata.file_change === undefined
        ? {}
        : { file_change: metadata.file_change }),
    };
    this.appendEntry(
      entry,
      event,
      `tool-result-${identitySegment(callId)}`,
      projected,
    );
  }

  private finishTurn(
    event: Extract<SessionEvent, { type: "turn/end" }>,
    projected: CoreEvent[],
  ): void {
    for (const assistant of this.assistants.values()) {
      if (
        assistant.turn !== event.data.turn ||
        assistant.entry.status !== "streaming"
      ) {
        continue;
      }
      assistant.open_blocks.clear();
      applyTurnEndReason(assistant.entry, event.data.reason);
      this.updateEntry(
        assistant.entry,
        event,
        `assistant-${assistant.step}-turn-end`,
        projected,
      );
    }
  }

  private ensureAssistant(
    turn: number,
    step: number,
    time: number,
    route: Route | undefined,
    sourceEvent: SessionEvent,
    projected: CoreEvent[],
  ): AssistantProjection {
    const key = assistantKey(turn, step);
    const existing = this.assistants.get(key);
    if (existing) return existing;
    const selectedRoute = route ?? this.latestRoute;
    if (!selectedRoute) {
      throw new Error("DSH assistant output arrived before request metadata.");
    }
    const entry: AssistantMessageEntry = {
      type: "assistant_message",
      entry_id: this.assistantEntryId(turn, step),
      run_id: this.runId(turn),
      created_at: new Date(time).toISOString(),
      status: "streaming",
      api: this.api,
      provider: selectedRoute.provider,
      model: selectedRoute.model,
      usage: emptyAssistantUsage(),
      blocks: [],
    };
    const assistant = {
      entry,
      open_blocks: new Map<number, OpenBlock>(),
      step,
      turn,
    };
    this.assistants.set(key, assistant);
    this.appendEntry(
      entry,
      sourceEvent,
      `assistant-${step}-start`,
      projected,
    );
    return assistant;
  }

  private toAssistantBlock(
    block: ContentBlock,
    turn: number,
    step: number,
    index: number,
  ): AssistantBlock {
    switch (block.type) {
      case "text":
        return {
          type: "assistant_text",
          block_id: this.indexBlockId(turn, step, index),
          text: block.text,
        };
      case "reasoning":
        return {
          type: "reasoning",
          block_id: this.indexBlockId(turn, step, index),
          text: block.text,
        };
      case "tool-call":
        return this.toTimelineToolCall(block, turn, step);
      default:
        throw new Error(
          `Unsupported DSH assistant message block: ${String(block.type)}.`,
        );
    }
  }

  private toTimelineToolCall(
    block: ToolCallBlock,
    turn: number,
    step: number,
  ): TimelineToolCallBlock {
    const callId = String(block.id);
    return {
      type: "tool_call",
      block_id: this.toolCallBlockId(turn, step, callId),
      tool_call_id: callId,
      tool_name: block.name,
      arguments: parseArguments(block.arguments, block.name),
    };
  }

  private registerToolCall(
    turn: number,
    step: number,
    block: TimelineToolCallBlock,
  ): void {
    const key = toolCallKey(turn, step, block.tool_call_id);
    const existing = this.toolCalls.get(key);
    if (existing) {
      if (
        existing.block_id !== block.block_id ||
        existing.name !== block.tool_name ||
        JSON.stringify(existing.arguments) !== JSON.stringify(block.arguments)
      ) {
        throw new Error(
          `Conflicting DSH tool call: ${block.tool_call_id}.`,
        );
      }
      return;
    }
    this.toolCalls.set(key, {
      arguments: structuredClone(block.arguments),
      block_id: block.block_id,
      name: block.tool_name,
    });
  }

  private appendEntry(
    entry: TimelineEntry,
    event: SessionEvent,
    suffix: string,
    projected: CoreEvent[],
  ): void {
    if (this.timelineIndexes.has(entry.entry_id)) {
      throw new Error(`Duplicate projected timeline entry: ${entry.entry_id}.`);
    }
    this.timelineIndexes.set(entry.entry_id, this.timeline.length);
    this.timeline.push(entry);
    projected.push(this.coreEvent(
      event,
      suffix,
      "timeline_entry_appended",
      { ...this.scope(), entry: structuredClone(entry) },
    ));
  }

  private updateEntry(
    entry: TimelineEntry,
    event: SessionEvent,
    suffix: string,
    projected: CoreEvent[],
  ): void {
    const index = this.timelineIndexes.get(entry.entry_id);
    if (index === undefined) {
      throw new Error(`Projected timeline entry is missing: ${entry.entry_id}.`);
    }
    this.timeline[index] = entry;
    projected.push(this.coreEvent(
      event,
      suffix,
      "timeline_entry_updated",
      { ...this.scope(), entry: structuredClone(entry) },
    ));
  }

  private coreEvent<TType extends CoreEvent["type"]>(
    source: SessionEvent,
    suffix: string,
    type: TType,
    payload: Extract<CoreEvent, { type: TType }>["payload"],
  ): Extract<CoreEvent, { type: TType }> {
    return {
      protocol_version: PROTOCOL_VERSION,
      event_id: [
        "dshrbox",
        identitySegment(this.sessionId),
        "event",
        String(source.seq),
        suffix,
      ].join(":"),
      type,
      payload,
    } as Extract<CoreEvent, { type: TType }>;
  }

  private assertNextEvent(event: SessionEvent): void {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new Error("DSH event seq must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(event.time) || event.time < 0) {
      throw new Error("DSH event time must be a non-negative integer.");
    }
    if (this.lastEventSeq === null) {
      if (event.seq !== 0) {
        throw new Error(`Expected first DSH event seq 0, received ${event.seq}.`);
      }
      return;
    }
    if (event.seq === this.lastEventSeq) return;
    if (event.seq !== this.lastEventSeq + 1) {
      throw new Error(
        `Expected DSH event seq ${this.lastEventSeq + 1}, received ${event.seq}.`,
      );
    }
  }

  private requireActiveTurn(): number {
    if (this.activeTurn === null) {
      throw new Error("DSH user message arrived outside an active turn.");
    }
    return this.activeTurn;
  }

  private scope(): { project_id: string; session_id: string } {
    return {
      project_id: this.projectId,
      session_id: this.sessionId,
    };
  }

  private runId(turn: number): string {
    return [
      "dshrbox",
      identitySegment(this.sessionId),
      "turn",
      String(turn),
    ].join(":");
  }

  private messageEntryId(messageId: string): string {
    return [
      "dshrbox",
      identitySegment(this.sessionId),
      "message",
      identitySegment(messageId),
    ].join(":");
  }

  private assistantEntryId(turn: number, step: number): string {
    return [
      "dshrbox",
      identitySegment(this.sessionId),
      "turn",
      String(turn),
      "step",
      String(step),
      "assistant",
    ].join(":");
  }

  private indexBlockId(turn: number, step: number, index: number): string {
    return [
      this.assistantEntryId(turn, step),
      "block",
      String(index),
    ].join(":");
  }

  private toolCallBlockId(
    turn: number,
    step: number,
    callId: string,
  ): string {
    return dshrboxToolCallBlockId(
      this.sessionId,
      turn,
      step,
      callId,
    );
  }
}

function assistantKey(turn: number, step: number): string {
  return `${turn}:${step}`;
}

function toolCallKey(turn: number, step: number, callId: string): string {
  return `${turn}:${step}:${identitySegment(callId)}`;
}

function requireAssistantBlock(
  entry: AssistantMessageEntry,
  blockId: string,
): AssistantBlock {
  const block = entry.blocks.find((candidate) => candidate.block_id === blockId);
  if (!block) throw new Error(`Projected assistant block is missing: ${blockId}.`);
  return block;
}

function hasToolCallBlock(
  entry: AssistantMessageEntry,
  callId: string,
): boolean {
  return entry.blocks.some(
    (block) => block.type === "tool_call" && block.tool_call_id === callId,
  );
}

function applyFinishReason(
  entry: AssistantMessageEntry,
  reason: FinishReason,
): void {
  switch (reason.kind) {
    case "stop":
      entry.status = "complete";
      entry.stop_reason = "stop";
      delete entry.error_message;
      break;
    case "tool-calls":
      entry.status = "complete";
      entry.stop_reason = "tool_use";
      delete entry.error_message;
      break;
    case "max-tokens":
      entry.status = "complete";
      entry.stop_reason = "length";
      delete entry.error_message;
      break;
    case "aborted":
      entry.status = "aborted";
      entry.stop_reason = "aborted";
      entry.error_message = reason.failure.message;
      break;
    case "error":
      entry.status = "error";
      entry.stop_reason = "error";
      entry.error_message = reason.failure.message;
      break;
    default:
      throw unsupportedKind("finish reason", reason);
  }
}

function applyImportedAssistantMetadata(
  entry: AssistantMessageEntry,
  replayState: unknown,
): void {
  if (!isRecord(replayState)) return;
  const imported = replayState.dshrbox_import;
  if (
    !isRecord(imported) ||
    imported.kind !== "researchbox_timeline_v5" ||
    typeof imported.api !== "string" ||
    !isAssistantStatus(imported.status)
  ) {
    return;
  }
  entry.api = imported.api;
  entry.status = imported.status;
  setOptionalString(entry, "response_model", imported.response_model);
  setOptionalString(entry, "response_id", imported.response_id);
  setOptionalString(entry, "error_message", imported.error_message);
  if (isAssistantStopReason(imported.stop_reason)) {
    entry.stop_reason = imported.stop_reason;
  } else {
    delete entry.stop_reason;
  }
  const usage = imported.usage;
  if (isAssistantUsage(usage)) entry.usage = structuredClone(usage);
  if (Array.isArray(imported.blocks)) {
    for (const [index, raw] of imported.blocks.entries()) {
      const block = entry.blocks[index];
      if (!block || !isRecord(raw)) continue;
      if (block.type === "assistant_text" && raw.type === "assistant_text") {
        copyOptionalString(block, "text_signature", raw.text_signature);
      } else if (block.type === "reasoning" && raw.type === "reasoning") {
        copyOptionalString(block, "thinking_signature", raw.thinking_signature);
        if (typeof raw.redacted === "boolean") block.redacted = raw.redacted;
      } else if (block.type === "tool_call" && raw.type === "tool_call") {
        copyOptionalString(block, "thought_signature", raw.thought_signature);
        copyOptionalString(block, "label", raw.label);
        copyOptionalString(block, "progress_summary", raw.progress_summary);
      }
    }
  }
}

function isAssistantStatus(
  value: unknown,
): value is AssistantMessageEntry["status"] {
  return value === "complete" || value === "aborted" || value === "error";
}

function isAssistantStopReason(
  value: unknown,
): value is NonNullable<AssistantMessageEntry["stop_reason"]> {
  return value === "stop" || value === "length" || value === "tool_use" ||
    value === "error" || value === "aborted";
}

function isAssistantUsage(value: unknown): value is AssistantUsage {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  return [
    value.input,
    value.output,
    value.cache_read,
    value.cache_write,
    value.total_tokens,
    value.cost.input,
    value.cost.output,
    value.cost.cache_read,
    value.cost.cache_write,
    value.cost.total,
  ].every((candidate) =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
  );
}

function setOptionalString<
  TKey extends "response_model" | "response_id" | "error_message",
>(
  entry: AssistantMessageEntry,
  key: TKey,
  value: unknown,
): void {
  if (typeof value === "string") {
    entry[key] = value;
  } else {
    delete entry[key];
  }
}

function copyOptionalString<T extends object, TKey extends keyof T>(
  target: T,
  key: TKey,
  value: unknown,
): void {
  if (typeof value === "string") target[key] = value as T[TKey];
}

function applyTurnEndReason(
  entry: AssistantMessageEntry,
  reason: TurnEndReason,
): void {
  switch (reason.kind) {
    case "completed":
      entry.status = "complete";
      entry.stop_reason = entry.blocks.some(
        (block) => block.type === "tool_call",
      ) ? "tool_use" : "stop";
      break;
    case "max-tokens":
      entry.status = "complete";
      entry.stop_reason = "length";
      break;
    case "aborted":
      entry.status = "aborted";
      entry.stop_reason = "aborted";
      break;
    case "interrupted":
      entry.status = "aborted";
      entry.stop_reason = "aborted";
      entry.error_message = "The DSH turn was interrupted.";
      break;
    case "blocked":
      entry.status = "error";
      entry.stop_reason = "error";
      entry.error_message = "The DSH turn was blocked.";
      break;
    case "error":
      entry.status = "error";
      entry.stop_reason = "error";
      entry.error_message = reason.error.message;
      break;
    default:
      throw unsupportedKind("turn end reason", reason);
  }
}

function toAssistantUsage(usage: TokenUsage): AssistantUsage {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total_tokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total: 0,
    },
  };
}

function textContent(blocks: readonly ContentBlock[], label: string): string {
  return blocks.map((block) => {
    if (block.type !== "text") {
      throw new Error(
        `Unsupported ${String(block.type)} block in ${label}.`,
      );
    }
    return block.text;
  }).join("\n");
}

function projectToolResultMetadata(
  value: unknown,
  toolCallId: string,
  toolName: string,
): {
  summary?: string;
  file_change?: WorkspaceChangeSummary;
  workspace_revision?: number;
} {
  if (!isRecord(value)) return {};
  const summary = typeof value.summary === "string"
    ? value.summary
    : undefined;
  const fileChange = parseProjectedWorkspaceChange(
    value.file_change,
    toolCallId,
    toolName,
  );
  const workspaceRevision = Number.isSafeInteger(value.workspace_revision) &&
      (value.workspace_revision as number) >= 0
    ? value.workspace_revision as number
    : undefined;
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(fileChange === undefined ? {} : { file_change: fileChange }),
    ...(workspaceRevision === undefined
      ? {}
      : { workspace_revision: workspaceRevision }),
  };
}

function parseProjectedWorkspaceChange(
  value: unknown,
  toolCallId: string,
  toolName: string,
): WorkspaceChangeSummary | undefined {
  if (value === undefined) return undefined;
  try {
    const change = parseWorkspaceChangeSummary(value);
    return change.tool_call_id === toolCallId && change.tool_name === toolName
      ? change
      : undefined;
  } catch {
    return undefined;
  }
}

function parseArguments(
  value: string,
  toolName: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const invalidArguments = new Error(
      `Invalid JSON arguments for DSH tool ${toolName}.`,
    );
    Object.defineProperty(invalidArguments, "cause", {
      configurable: true,
      value: error,
    });
    throw invalidArguments;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(`DSH tool ${toolName} arguments must be an object.`);
  }
  return structuredClone(parsed as Record<string, unknown>);
}

function eventTimestamp(event: SessionEvent): string {
  return new Date(event.time).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReplacementSurfaceEvent(event: SessionEvent): boolean {
  if (
    event.type !== "user/message" &&
    event.type !== "assistant/message" &&
    event.type !== "tool/result"
  ) {
    return false;
  }
  return typeof event.surfaceOp === "object";
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function identitySegment(value: string): string {
  return encodeURIComponent(value);
}

function unsupportedKind(label: string, value: unknown): Error {
  const kind = typeof value === "object" && value !== null && "kind" in value
    ? String(value.kind)
    : "unknown";
  return new Error(`Unsupported DSH ${label}: ${kind}.`);
}
