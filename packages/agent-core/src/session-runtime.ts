import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  Type,
  type AssistantMessage,
  type Model,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ModelTransport } from "@researchbox/model-transport";
import {
  synchronizeSessionHistory,
  type SessionDocument,
} from "@researchbox/project-store";
import {
  PROTOCOL_VERSION,
  type AssistantBlock,
  type AssistantMessageEntry,
  type CoreEvent,
  type ModelSelection,
  type ReasoningEffort,
  type SummaryReviewRequest,
  type SummaryReviewResolution,
  type ToolCallBlock,
  type UserMessageEntry,
  type WorkspaceChangeSummary,
} from "@researchbox/protocol";
import type {
  WorkspaceChangeMetadata,
  WorkspaceChangeRecord,
} from "@researchbox/vfs";
import { searchWorkspaceText } from "@researchbox/workspace-search";
import { createModelStreamFn } from "./pi-stream.ts";
import {
  createAgentPluginTools,
  type AgentPlugin,
  type SummaryReviewInteraction,
} from "./agent-plugin.ts";
import {
  createStreamingAssistantEntry,
  createToolResultEntry,
  finalizeAssistantEntry,
  timelineToAgentMessages,
} from "./session-codec.ts";
import { repairUnansweredToolCalls } from "./tool-transcript.ts";
import { WorkspaceController } from "./workspace-controller.ts";

export type CoreEventSink = (event: CoreEvent) => void;

export type SessionRuntimeOptions = {
  project_id: string;
  session_id: string;
  document: SessionDocument;
  workspace: WorkspaceController;
  model_transport: ModelTransport;
  model: Model<string>;
  reasoning_effort: ReasoningEffort;
  resolve_model?: (selection: ModelSelection) => Model<string> | undefined;
  system_prompt: string;
  plugins?: readonly AgentPlugin[];
  event_sink: CoreEventSink;
  checkpoint: (
    phase: "staged" | "tool_started" | "tool_finished" | "finished",
    requestId: string,
  ) => Promise<void>;
};

type WorkspaceToolDetails = {
  summary: string;
  file_change?: WorkspaceChangeSummary;
};

type MutationToolName = "write_file" | "replace_text" | "remove_file";

type FileMutationResult =
  | Awaited<ReturnType<WorkspaceController["write"]>>
  | Awaited<ReturnType<WorkspaceController["remove"]>>;

type ActiveRun = {
  request_id: string;
  run_id: string;
  user_entry_index: number;
  abort_requested: boolean;
  transcript_boundary: number;
  assistant_entry_id: string | null;
  block_ids_by_content_index: Map<number, string>;
  unresolved_tool_blocks: Map<string, string>;
};

type PendingSummaryReview = {
  request: SummaryReviewRequest;
  activity_listeners: Set<() => void>;
  visibility_listeners: Set<(isVisible: boolean) => void>;
  is_visible: boolean;
  signal?: AbortSignal;
  on_abort?: () => void;
  resolve(resolution: SummaryReviewResolution): void;
  reject(error: Error): void;
};

export type StagedPrompt = {
  user_entry: UserMessageEntry;
  run_id: string;
};

function cloneSummaryReviewRequest(
  request: Omit<SummaryReviewRequest, "interaction_id">,
  interactionId: string,
): SummaryReviewRequest {
  return {
    interaction_id: interactionId,
    stage: request.stage,
    is_loading: request.is_loading,
    loading_phase: request.loading_phase,
    auto_submit_at: request.auto_submit_at,
    title: request.title,
    draft_text: request.draft_text,
    summary_model: request.summary_model
      ? { ...request.summary_model }
      : null,
    draft_metadata: request.draft_metadata
      ? structuredClone(request.draft_metadata)
      : null,
    query_draft: request.query_draft,
    query_notice: request.query_notice,
    search_providers: structuredClone(request.search_providers),
    search_provider: request.search_provider,
    sections: structuredClone(request.sections),
    selected_section_ids: [...request.selected_section_ids],
  };
}

export class SessionRuntime {
  readonly project_id: string;
  readonly session_id: string;
  private document: SessionDocument;
  private readonly workspace: WorkspaceController;
  private readonly eventSink: CoreEventSink;
  private readonly checkpoint: SessionRuntimeOptions["checkpoint"];
  private readonly model: Model<string>;
  private readonly agent: Agent;
  private readonly unsubscribe: () => void;
  private activeRun: ActiveRun | null = null;
  private runPromise: Promise<void> | null = null;
  private pendingSummaryReview: PendingSummaryReview | null = null;

  constructor(options: SessionRuntimeOptions) {
    this.project_id = options.project_id;
    this.session_id = options.session_id;
    this.document = options.document;
    this.workspace = options.workspace;
    this.eventSink = options.event_sink;
    this.checkpoint = options.checkpoint;
    this.model = options.model;
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.system_prompt,
        model: options.model,
        thinkingLevel:
          options.reasoning_effort === "default" ||
          options.reasoning_effort === "none"
            ? "off"
            : options.reasoning_effort,
        tools: createAgentPluginTools(
          options.plugins ?? [],
          {
            project_id: options.project_id,
            session_id: options.session_id,
            complete_model: (prompt, signal, selection) =>
              completePluginModel(
                options.model_transport,
                resolvePluginModel(options, selection),
                options.session_id,
                prompt,
                signal,
              ),
            request_summary_review: (request, signal) =>
              this.requestSummaryReview(request, signal),
            open_summary_review: (request, signal) =>
              this.openSummaryReview(request, signal),
          },
          this.createTools(),
        ),
        messages: timelineToAgentMessages(options.document.timeline),
      },
      sessionId: options.session_id,
      streamFn: createModelStreamFn(
        options.model_transport,
        options.reasoning_effort === "none" ? "none" : undefined,
      ),
      toolExecution: "sequential",
    });
    this.unsubscribe = this.agent.subscribe((event) =>
      this.handleAgentEvent(event),
    );
  }

  get is_running(): boolean {
    return this.activeRun !== null || this.agent.state.isStreaming;
  }

  usesModel(model: Model<string>): boolean {
    return this.model === model;
  }

  bindDocument(document: SessionDocument): void {
    if (this.is_running) {
      throw new Error("Cannot replace a session document while a run is active.");
    }
    this.document = document;
  }

  startPrompt(text: string, requestId: string): Promise<void> {
    return this.trackRun(() => this.executePrompt(text, requestId));
  }

  continueStagedPrompt(
    runId: string,
    requestId: string,
  ): Promise<void> {
    return this.trackRun(async () => {
      const userEntryIndex = this.document.timeline.findIndex(
        (entry) => entry.type === "user_message" && entry.run_id === runId,
      );
      if (userEntryIndex === -1) {
        throw new Error("The staged user message is not available.");
      }
      this.agent.state.messages = timelineToAgentMessages(
        this.document.timeline,
      );
      this.activeRun = createActiveRun(
        requestId,
        runId,
        userEntryIndex,
        this.agent.state.messages.length,
      );
      this.emit("run_state", { is_running: true }, requestId);
      await this.completePrompt(requestId);
    });
  }

  abort(): void {
    if (this.activeRun) this.activeRun.abort_requested = true;
    this.rejectSummaryReview(
      new DOMException("Summary review was cancelled.", "AbortError"),
    );
    this.agent.abort();
  }

  async stopAndWait(): Promise<void> {
    this.abort();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    await this.runPromise;
    await this.agent.waitForIdle();
  }

  dispose(): void {
    if (this.is_running) {
      throw new Error("Cannot dispose a running session.");
    }
    this.unsubscribe();
  }

  resolveSummaryReview(
    interactionId: string,
    resolution: SummaryReviewResolution,
  ): void {
    const pending = this.pendingSummaryReview;
    if (!pending || pending.request.interaction_id !== interactionId) {
      throw new Error("The summary review is no longer pending.");
    }
    const allowedWhileLoading = pending.request.loading_phase === "search"
      ? (
        resolution.decision === "change-provider" ||
        resolution.decision === "dismiss"
      )
      : pending.request.loading_phase === "summary-grace" ||
          pending.request.loading_phase === "summary"
      ? (
        resolution.decision === "change-provider" ||
        resolution.decision === "add-search" ||
        resolution.decision === "dismiss"
      )
      : false;
    if (
      pending.request.is_loading &&
      resolution.decision !== "cancel" &&
      !allowedWhileLoading
    ) {
      throw new Error(
        "The summary review cannot be submitted while it is loading.",
      );
    }
    const availableIds = new Set(
      pending.request.sections.map((section) => section.section_id),
    );
    const selectableIds = new Set(
      pending.request.sections
        .filter((section) => section.is_selectable)
        .map((section) => section.section_id),
    );
    const searchProviderIds = new Set(
      pending.request.search_providers.map(
        (provider) => provider.provider_id,
      ),
    );
    if (
      resolution.search_provider !== null &&
      !searchProviderIds.has(resolution.search_provider)
    ) {
      throw new Error(
        "The summary review selected an unavailable search provider.",
      );
    }
    if (
      resolution.decision === "change-provider" &&
      resolution.search_provider === null
    ) {
      throw new Error(
        "The summary review requires a search provider.",
      );
    }
    if (
      resolution.selected_section_ids.some(
        (sectionId) =>
          !availableIds.has(sectionId) ||
          !selectableIds.has(sectionId),
      )
    ) {
      throw new Error(
        "The summary review selected an unavailable section.",
      );
    }
    if (
      pending.request.stage !== "select-evidence" &&
      (
        resolution.decision === "add-search" ||
        resolution.decision === "rewrite-query" ||
        resolution.decision === "change-provider"
      )
    ) {
      throw new Error(
        "Query curation is unavailable during summary review.",
      );
    }
    this.clearPendingSummaryReview();
    pending.resolve(structuredClone(resolution));
  }

  touchSummaryReview(interactionId: string): boolean {
    const pending = this.pendingSummaryReview;
    if (!pending || pending.request.interaction_id !== interactionId) {
      return false;
    }
    for (const listener of [...pending.activity_listeners]) {
      try {
        listener();
      } catch {
        // Plugin activity observers must not break core command handling.
      }
    }
    return true;
  }

  setSummaryReviewVisibility(
    interactionId: string,
    isVisible: boolean,
  ): boolean {
    const pending = this.pendingSummaryReview;
    if (!pending || pending.request.interaction_id !== interactionId) {
      return false;
    }
    if (pending.is_visible === isVisible) return true;
    pending.is_visible = isVisible;
    for (const listener of [...pending.visibility_listeners]) {
      try {
        listener(isVisible);
      } catch {
        // Plugin visibility observers must not break core command handling.
      }
    }
    return true;
  }

  private async executePrompt(text: string, requestId: string): Promise<void> {
    const timelineLength = this.document.timeline.length;
    const previousInputDraft = this.document.input_draft;
    const previousAgentMessages = [...this.agent.state.messages];
    const staged = stagePrompt(this.document, text);
    this.agent.state.messages = timelineToAgentMessages(
      this.document.timeline,
    );
    this.activeRun = createActiveRun(
      requestId,
      staged.run_id,
      timelineLength,
      this.agent.state.messages.length,
    );

    try {
      await this.checkpoint("staged", requestId);
    } catch (error) {
      this.document.timeline.splice(timelineLength);
      this.document.input_draft = previousInputDraft;
      this.agent.state.messages = previousAgentMessages;
      this.activeRun = null;
      this.emitPersistenceError(error, requestId);
      return;
    }

    this.emit(
      "timeline_entry_appended",
      { entry: structuredClone(staged.user_entry) },
      requestId,
    );
    this.emit("run_state", { is_running: true }, requestId);
    await this.completePrompt(requestId);
  }

  private requestSummaryReview(
    request: Omit<SummaryReviewRequest, "interaction_id">,
    signal?: AbortSignal,
  ): Promise<SummaryReviewResolution> {
    try {
      return this.openSummaryReview(request, signal).resolution;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private openSummaryReview(
    request: Omit<SummaryReviewRequest, "interaction_id">,
    signal?: AbortSignal,
  ): SummaryReviewInteraction {
    if (this.pendingSummaryReview) {
      throw new Error("Another summary review is already pending.");
    }
    if (!this.activeRun) {
      throw new Error("Summary review requires an active agent run.");
    }
    if (signal?.aborted) {
      throw new DOMException(
        "Summary review was cancelled.",
        "AbortError",
      );
    }
    const interactionId = crypto.randomUUID();
    const review = cloneSummaryReviewRequest(request, interactionId);
    const resolution = new Promise<SummaryReviewResolution>(
      (resolve, reject) => {
        const pending: PendingSummaryReview = {
          request: review,
          activity_listeners: new Set(),
          visibility_listeners: new Set(),
          is_visible: true,
          signal,
          resolve,
          reject,
        };
        if (signal) {
          pending.on_abort = () => {
            if (this.pendingSummaryReview !== pending) return;
            this.clearPendingSummaryReview();
            if (this.activeRun) {
              this.emit(
                "summary_review_resolved",
                {
                  interaction_id: review.interaction_id,
                  decision: "dismiss",
                },
                this.activeRun.request_id,
              );
            }
            reject(
              new DOMException(
                "Summary review was cancelled.",
                "AbortError",
              ),
            );
          };
          signal.addEventListener("abort", pending.on_abort, {
            once: true,
          });
        }
        this.pendingSummaryReview = pending;
      },
    );
    this.emit(
      "summary_review_requested",
      structuredClone(review),
      this.activeRun.request_id,
    );
    return {
      resolution,
      is_visible: () => {
        const pending = this.pendingSummaryReview;
        return pending?.request.interaction_id === interactionId
          ? pending.is_visible
          : false;
      },
      subscribe_activity: (listener) => {
        const pending = this.pendingSummaryReview;
        if (
          !pending ||
          pending.request.interaction_id !== interactionId
        ) {
          return () => undefined;
        }
        pending.activity_listeners.add(listener);
        return () => {
          pending.activity_listeners.delete(listener);
        };
      },
      subscribe_visibility: (listener) => {
        const pending = this.pendingSummaryReview;
        if (
          !pending ||
          pending.request.interaction_id !== interactionId
        ) {
          return () => undefined;
        }
        pending.visibility_listeners.add(listener);
        return () => {
          pending.visibility_listeners.delete(listener);
        };
      },
      update: (updatedRequest) => {
        const pending = this.pendingSummaryReview;
        if (
          !pending ||
          pending.request.interaction_id !== interactionId ||
          !this.activeRun
        ) {
          throw new Error("The summary review is no longer pending.");
        }
        const updatedReview = cloneSummaryReviewRequest(
          updatedRequest,
          interactionId,
        );
        pending.request = updatedReview;
        this.emit(
          "summary_review_updated",
          structuredClone(updatedReview),
          this.activeRun.request_id,
        );
      },
    };
  }

  private rejectSummaryReview(error: Error): void {
    const pending = this.pendingSummaryReview;
    if (!pending) return;
    this.clearPendingSummaryReview();
    pending.reject(error);
  }

  private clearPendingSummaryReview(): void {
    const pending = this.pendingSummaryReview;
    if (!pending) return;
    if (pending.signal && pending.on_abort) {
      pending.signal.removeEventListener("abort", pending.on_abort);
    }
    pending.activity_listeners.clear();
    pending.visibility_listeners.clear();
    this.pendingSummaryReview = null;
  }

  private async completePrompt(requestId: string): Promise<void> {
    let status: "complete" | "aborted" | "error" = "complete";
    let errorMessage: string | undefined;
    try {
      if (this.activeRun?.abort_requested) {
        status = "aborted";
      } else {
        await this.agent.continue();
        const agentError = this.agent.state.errorMessage;
        const stopReason = latestAssistantStopReason(this.agent);
        if (this.activeRun?.abort_requested) {
          status = "aborted";
        } else if (stopReason === "length") {
          status = "error";
          errorMessage = "The model stopped because it reached its output limit.";
        } else {
          status =
            stopReason === "aborted"
              ? "aborted"
              : stopReason === "error" || agentError
                ? "error"
                : "complete";
          errorMessage = agentError;
        }
      }
    } catch (error) {
      errorMessage = toErrorMessage(error, "The agent run failed.");
      status =
        latestAssistantStopReason(this.agent) === "aborted" ||
        isAbortError(error) ||
        this.activeRun?.abort_requested
          ? "aborted"
          : "error";
    }

    try {
      this.agent.state.messages = repairUnansweredToolCalls(
        this.agent.state.messages,
        status === "aborted"
          ? "Tool execution was skipped because the run was aborted."
          : "Tool execution did not complete.",
      ).messages;
    } catch (error) {
      status = "error";
      errorMessage = toErrorMessage(error, "The model returned an invalid tool transcript.");
      this.agent.state.messages = this.agent.state.messages.slice(
        0,
        this.activeRun?.transcript_boundary ?? 0,
      );
      this.discardActiveRunOutput();
    }
    if (this.hasAbandonedStreamingAssistant()) {
      if (status === "complete") {
        status = "error";
        errorMessage =
          "The agent run ended before its assistant message was finalized.";
      }
      this.finalizeAbandonedStreamingAssistant(
        status,
        errorMessage,
        requestId,
      );
    }
    try {
      this.synchronizeMissingToolResults(
        status === "aborted"
          ? "Tool execution was stopped"
          : "Tool execution did not complete",
        requestId,
      );
    } catch (error) {
      status = "error";
      errorMessage = toErrorMessage(
        error,
        "The model returned an invalid tool transcript.",
      );
      this.agent.state.messages = this.agent.state.messages.slice(
        0,
        this.activeRun?.transcript_boundary ?? 0,
      );
      this.discardActiveRunOutput();
    }
    if (this.agent.state.messages.at(-1)?.role === "user") {
      const terminal = createTerminalAgentMessage(
        this.agent,
        status,
        errorMessage,
      );
      this.agent.state.messages = [...this.agent.state.messages, terminal];
      this.appendTerminalAssistant(terminal, requestId);
    }
    try {
      await this.checkpoint("finished", requestId);
    } catch (error) {
      this.emitPersistenceError(error, requestId);
    }

    if (status === "error") {
      this.emitError(
        "agent_run_failed",
        errorMessage ?? "The agent run failed.",
        requestId,
      );
    }
    this.activeRun = null;
    this.emit("run_state", { is_running: false }, requestId);
  }

  private trackRun(operation: () => Promise<void>): Promise<void> {
    if (this.runPromise || this.is_running) {
      throw new Error("A session run is already active.");
    }
    const runPromise = operation();
    this.runPromise = runPromise.finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const run = this.activeRun;
    if (!run) return;

    if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        this.appendMissingToolResultsBeforeAssistant(
          event.message,
          run.request_id,
        );
        const entry = createStreamingAssistantEntry(
          event.message,
          run.run_id,
        );
        run.assistant_entry_id = entry.entry_id;
        run.block_ids_by_content_index.clear();
        this.appendTimelineEntry(entry, run.request_id);
      } else if (event.message.role === "toolResult") {
        this.appendToolResult(event.message, run.request_id);
      }
      return;
    }

    if (event.type === "message_update") {
      this.handleAssistantMessageUpdate(
        event.assistantMessageEvent,
        run.request_id,
      );
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        const entry = this.requireActiveAssistantEntry();
        const finalized = finalizeAssistantEntry(entry, event.message);
        this.replaceTimelineEntry(finalized);
        for (const block of finalized.blocks) {
          if (
            block.type === "tool_call" &&
            !this.hasToolResult(block.block_id)
          ) {
            const existing = run.unresolved_tool_blocks.get(
              block.tool_call_id,
            );
            if (existing && existing !== block.block_id) {
              throw new Error(
                `Duplicate unresolved tool call id: ${block.tool_call_id}`,
              );
            }
            run.unresolved_tool_blocks.set(
              block.tool_call_id,
              block.block_id,
            );
          }
        }
        this.emit(
          "timeline_entry_updated",
          { entry: structuredClone(finalized) },
          run.request_id,
        );
        run.assistant_entry_id = null;
        run.block_ids_by_content_index.clear();
      } else if (
        event.message.role === "toolResult" &&
        isMutationToolName(event.message.toolName)
      ) {
        try {
          await this.checkpoint("tool_finished", run.request_id);
        } catch (error) {
          this.emitPersistenceError(error, run.request_id);
          throw error;
        }
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const block = this.requireUnresolvedToolCall(
        event.toolCallId,
        event.toolName,
      );
      const updated: ToolCallBlock = {
        ...block,
        label: toolLabel(event.toolName, event.args),
      };
      this.replaceAssistantBlock(updated);
      this.emit(
        "assistant_block_updated",
        {
          entry_id: this.requireAssistantEntryIdForBlock(updated.block_id),
          block: structuredClone(updated),
        },
        run.request_id,
      );
      if (isMutationToolName(event.toolName)) {
        try {
          await this.checkpoint("tool_started", run.request_id);
        } catch (error) {
          this.emitPersistenceError(error, run.request_id);
          throw error;
        }
      }
      return;
    }

    if (event.type === "tool_execution_update") {
      const block = this.requireUnresolvedToolCall(
        event.toolCallId,
        event.toolName,
      );
      const summary = toolProgressSummary(event.partialResult);
      if (summary === null || summary === block.progress_summary) return;
      const updated: ToolCallBlock = {
        ...block,
        progress_summary: summary,
      };
      this.replaceAssistantBlock(updated);
      this.emit(
        "assistant_block_updated",
        {
          entry_id: this.requireAssistantEntryIdForBlock(updated.block_id),
          block: structuredClone(updated),
        },
        run.request_id,
      );
      return;
    }
  }

  private handleAssistantMessageUpdate(
    event: Extract<
      AgentEvent,
      { type: "message_update" }
    >["assistantMessageEvent"],
    requestId: string,
  ): void {
    const run = this.requireActiveRun();
    const entry = this.requireActiveAssistantEntry();

    switch (event.type) {
      case "text_start": {
        const block: AssistantBlock = {
          type: "assistant_text",
          block_id: this.reserveContentBlockId(event.contentIndex),
          text: "",
        };
        this.appendAssistantBlock(entry.entry_id, block, requestId);
        return;
      }
      case "thinking_start": {
        const block: AssistantBlock = {
          type: "reasoning",
          block_id: this.reserveContentBlockId(event.contentIndex),
          text: "",
        };
        this.appendAssistantBlock(entry.entry_id, block, requestId);
        return;
      }
      case "text_delta":
      case "thinking_delta": {
        const blockId = this.requireContentBlockId(event.contentIndex);
        const block = this.requireAssistantBlock(blockId);
        const expectedType =
          event.type === "text_delta" ? "assistant_text" : "reasoning";
        if (block.type !== expectedType) {
          throw new Error(
            `Assistant content index ${event.contentIndex} changed type.`,
          );
        }
        block.text += event.delta;
        this.emit(
          "assistant_block_delta",
          {
            entry_id: entry.entry_id,
            block_id: block.block_id,
            block_type: block.type,
            text_delta: event.delta,
          },
          requestId,
        );
        return;
      }
      case "text_end":
      case "thinking_end": {
        const blockId = this.requireContentBlockId(event.contentIndex);
        const block = this.requireAssistantBlock(blockId);
        const partial = event.partial.content[event.contentIndex];
        if (event.type === "text_end") {
          if (block.type !== "assistant_text" || partial?.type !== "text") {
            throw new Error("Assistant text block ended with invalid state.");
          }
          block.text = event.content;
          if (partial.textSignature !== undefined) {
            block.text_signature = partial.textSignature;
          }
        } else {
          if (block.type !== "reasoning" || partial?.type !== "thinking") {
            throw new Error(
              "Assistant reasoning block ended with invalid state.",
            );
          }
          block.text = event.content;
          if (partial.thinkingSignature !== undefined) {
            block.thinking_signature = partial.thinkingSignature;
          }
          if (partial.redacted !== undefined) {
            block.redacted = partial.redacted;
          }
        }
        this.emit(
          "assistant_block_updated",
          {
            entry_id: entry.entry_id,
            block: structuredClone(block),
          },
          requestId,
        );
        return;
      }
      case "toolcall_start":
        this.reserveContentBlockId(event.contentIndex);
        return;
      case "toolcall_delta":
        this.requireContentBlockId(event.contentIndex);
        return;
      case "toolcall_end": {
        const toolCall = event.toolCall;
        const block: ToolCallBlock = {
          type: "tool_call",
          block_id: this.requireContentBlockId(event.contentIndex),
          tool_call_id: toolCall.id,
          tool_name: toolCall.name,
          arguments: structuredClone(toolCall.arguments),
          ...(toolCall.thoughtSignature === undefined
            ? {}
            : { thought_signature: toolCall.thoughtSignature }),
          label: toolLabel(toolCall.name, toolCall.arguments),
        };
        if (run.unresolved_tool_blocks.has(toolCall.id)) {
          throw new Error(`Duplicate unresolved tool call id: ${toolCall.id}`);
        }
        this.insertAssistantBlockByContentIndex(
          entry.entry_id,
          event.contentIndex,
          block,
          requestId,
        );
        run.unresolved_tool_blocks.set(toolCall.id, block.block_id);
        return;
      }
      case "start":
      case "done":
      case "error":
        return;
    }
  }

  private createTools(): AgentTool[] {
    const pathParameters = Type.Object({
      path: Type.String({ description: "Absolute path inside the workspace" }),
    });

    const listFiles: AgentTool<typeof pathParameters, { summary: string }> = {
      name: "list_files",
      label: "List files",
      description: "List files and directories at a workspace path.",
      parameters: pathParameters,
      execute: async (_toolCallId, params) => {
        const { entries } = await this.workspace.list(params.path);
        return {
          content: [{ type: "text", text: JSON.stringify(entries) }],
          details: { summary: `${entries.length} entries found` },
        };
      },
    };

    const searchParameters = Type.Object({
      path: Type.String({ description: "Absolute file or directory path" }),
      query: Type.String({
        minLength: 1,
        description: "Case-sensitive, single-line literal text to find",
      }),
    });
    const searchFiles: AgentTool<
      typeof searchParameters,
      { summary: string }
    > = {
      name: "search_files",
      label: "Search files",
      description:
        "Search workspace text files for a literal query, returning bounded line matches.",
      parameters: searchParameters,
      execute: async (_toolCallId, params, signal) => {
        const result = await searchWorkspaceText(
          this.workspace,
          params,
          signal,
        );
        const matchLabel = result.matches.length === 1 ? "match" : "matches";
        const fileLabel = result.files_scanned === 1 ? "file" : "files";
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: {
            summary:
              `${result.matches.length} ${matchLabel} in ` +
              `${result.files_scanned} ${fileLabel}` +
              (result.truncated ? " (truncated)" : ""),
          },
        };
      },
    };

    const readFile: AgentTool<typeof pathParameters, { summary: string }> = {
      name: "read_file",
      label: "Read file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: pathParameters,
      execute: async (_toolCallId, params) => {
        const { content } = await this.workspace.read(params.path);
        return {
          content: [{ type: "text", text: content }],
          details: { summary: `${content.split("\n").length} lines read` },
        };
      },
    };

    const writeParameters = Type.Object({
      path: Type.String({ description: "Absolute path inside the workspace" }),
      content: Type.String({ description: "Complete UTF-8 file content" }),
    });
    const writeFile: AgentTool<
      typeof writeParameters,
      WorkspaceToolDetails
    > = {
      name: "write_file",
      label: "Write file",
      description: "Create or replace a UTF-8 text file in the workspace.",
      parameters: writeParameters,
      execute: async (toolCallId, params) => {
        const write = await this.workspace.write(
          params.path,
          params.content,
          {
            change: this.createChangeMetadata(toolCallId, "write_file"),
          },
        );
        return this.fileMutationResult(write, this.activeRequestId());
      },
    };

    const replaceParameters = Type.Object({
      path: Type.String({ description: "Absolute path inside the workspace" }),
      old_text: Type.String({
        description: "Exact literal text that must occur once",
      }),
      new_text: Type.String({ description: "Replacement text" }),
    });
    const replaceText: AgentTool<
      typeof replaceParameters,
      WorkspaceToolDetails
    > = {
      name: "replace_text",
      label: "Replace text",
      description:
        "Replace one unique literal text fragment in an existing workspace file.",
      parameters: replaceParameters,
      execute: async (toolCallId, params) => {
        if (params.old_text.length === 0) {
          throw new Error("old_text must not be empty.");
        }
        if (params.old_text === params.new_text) {
          throw new Error("old_text and new_text must be different.");
        }
        const { content } = await this.workspace.read(params.path);
        const matches = countOverlappingOccurrences(content, params.old_text);
        if (matches === 0) {
          throw new Error(
            "old_text was not found. Read the file again and use exact text.",
          );
        }
        if (matches !== 1) {
          throw new Error(
            "old_text occurs more than once. Include more surrounding text so the match is unique.",
          );
        }
        const index = content.indexOf(params.old_text);
        const nextContent =
          content.slice(0, index) +
          params.new_text +
          content.slice(index + params.old_text.length);
        const write = await this.workspace.write(
          params.path,
          nextContent,
          {
            expected_content: content,
            change: this.createChangeMetadata(toolCallId, "replace_text"),
          },
        );
        return this.fileMutationResult(write, this.activeRequestId());
      },
    };

    const removeFile: AgentTool<
      typeof pathParameters,
      WorkspaceToolDetails
    > = {
      name: "remove_file",
      label: "Remove file",
      description:
        "Delete one existing UTF-8 text file from the workspace.",
      parameters: pathParameters,
      execute: async (toolCallId, params) => {
        const { content } = await this.workspace.read(params.path);
        const removal = await this.workspace.remove(params.path, {
          expected_content: content,
          change: this.createChangeMetadata(toolCallId, "remove_file"),
        });
        return this.fileMutationResult(removal, this.activeRequestId());
      },
    };

    return [
      listFiles,
      searchFiles,
      readFile,
      writeFile,
      replaceText,
      removeFile,
    ];
  }

  private appendTimelineEntry(
    entry: SessionDocument["timeline"][number],
    requestId: string,
  ): void {
    this.document.timeline.push(entry);
    this.emit(
      "timeline_entry_appended",
      { entry: structuredClone(entry) },
      requestId,
    );
  }

  private appendAssistantBlock(
    entryId: string,
    block: AssistantBlock,
    requestId: string,
  ): void {
    const entry = this.requireAssistantEntry(entryId);
    if (entry.blocks.some((candidate) => candidate.block_id === block.block_id)) {
      throw new Error(`Duplicate assistant block id: ${block.block_id}`);
    }
    entry.blocks.push(block);
    this.emit(
      "assistant_block_appended",
      {
        entry_id: entryId,
        block: structuredClone(block),
      },
      requestId,
    );
  }

  private insertAssistantBlockByContentIndex(
    entryId: string,
    contentIndex: number,
    block: AssistantBlock,
    requestId: string,
  ): void {
    const entry = this.requireAssistantEntry(entryId);
    if (entry.blocks.some((candidate) => candidate.block_id === block.block_id)) {
      throw new Error(`Duplicate assistant block id: ${block.block_id}`);
    }
    const insertionIndex = entry.blocks.findIndex(
      (candidate) =>
        this.requireContentIndexForBlockId(candidate.block_id) > contentIndex,
    );
    if (insertionIndex === -1) {
      this.appendAssistantBlock(entryId, block, requestId);
      return;
    }
    entry.blocks.splice(insertionIndex, 0, block);
    this.emit(
      "timeline_entry_updated",
      { entry: structuredClone(entry) },
      requestId,
    );
  }

  private appendToolResult(
    message: ToolResultMessage,
    requestId: string,
    fallbackSummary?: string,
  ): void {
    const run = this.requireActiveRun();
    const block = this.requireUnresolvedToolCall(
      message.toolCallId,
      message.toolName,
    );
    const result = createToolResultEntry(
      message,
      run.run_id,
      block.block_id,
    );
    if (result.summary === undefined) {
      result.summary =
        fallbackSummary ??
        (result.is_error ? "Tool failed" : "Complete");
    }
    this.appendTimelineEntry(result, requestId);
    run.unresolved_tool_blocks.delete(message.toolCallId);
  }

  private appendTerminalAssistant(
    message: AssistantMessage,
    requestId: string,
  ): void {
    const run = this.requireActiveRun();
    const streaming = createStreamingAssistantEntry(message, run.run_id);
    const finalized = finalizeAssistantEntry(streaming, message);
    this.appendTimelineEntry(finalized, requestId);
  }

  private appendMissingToolResultsBeforeAssistant(
    message: AssistantMessage,
    requestId: string,
  ): void {
    const run = this.requireActiveRun();
    if (run.unresolved_tool_blocks.size === 0) return;

    const wasAborted =
      run.abort_requested || message.stopReason === "aborted";
    const content = wasAborted
      ? "Tool execution was skipped because the run was aborted."
      : "Tool execution did not complete.";
    const summary = wasAborted
      ? "Tool execution was stopped"
      : "Tool execution did not complete";

    for (const [toolCallId, blockId] of [
      ...run.unresolved_tool_blocks.entries(),
    ]) {
      const block = this.requireAssistantBlock(blockId);
      if (block.type !== "tool_call") {
        throw new Error(
          `Assistant block ${blockId} is not a tool call.`,
        );
      }
      this.appendToolResult(
        {
          role: "toolResult",
          toolCallId,
          toolName: block.tool_name,
          content: [{ type: "text", text: content }],
          isError: true,
          timestamp: Date.now(),
        },
        requestId,
        summary,
      );
    }
  }

  private hasAbandonedStreamingAssistant(): boolean {
    const runId = this.requireActiveRun().run_id;
    return this.document.timeline.some(
      (entry) =>
        entry.type === "assistant_message" &&
        entry.run_id === runId &&
        entry.status === "streaming",
    );
  }

  private finalizeAbandonedStreamingAssistant(
    status: "complete" | "aborted" | "error",
    errorMessage: string | undefined,
    requestId: string,
  ): void {
    const run = this.requireActiveRun();
    const terminalStatus = status === "aborted" ? "aborted" : "error";
    for (const entry of this.document.timeline) {
      if (
        entry.type !== "assistant_message" ||
        entry.run_id !== run.run_id ||
        entry.status !== "streaming"
      ) {
        continue;
      }
      entry.status = terminalStatus;
      entry.stop_reason = terminalStatus;
      if (terminalStatus === "error" && errorMessage !== undefined) {
        entry.error_message = errorMessage;
      }
      this.emit(
        "timeline_entry_updated",
        { entry: structuredClone(entry) },
        requestId,
      );
    }
    run.assistant_entry_id = null;
    run.block_ids_by_content_index.clear();
  }

  private synchronizeMissingToolResults(
    summary: string,
    requestId: string,
  ): void {
    const run = this.requireActiveRun();
    for (const message of this.agent.state.messages) {
      if (
        message.role !== "toolResult" ||
        !run.unresolved_tool_blocks.has(message.toolCallId)
      ) {
        continue;
      }
      this.appendToolResult(message, requestId, summary);
    }
    if (run.unresolved_tool_blocks.size > 0) {
      throw new Error(
        "The repaired agent transcript still has unanswered tool calls.",
      );
    }
  }

  private replaceTimelineEntry(
    entry: SessionDocument["timeline"][number],
  ): void {
    const index = this.document.timeline.findIndex(
      (candidate) => candidate.entry_id === entry.entry_id,
    );
    if (index === -1) {
      throw new Error(`Timeline entry does not exist: ${entry.entry_id}`);
    }
    this.document.timeline[index] = entry;
  }

  private discardActiveRunOutput(): void {
    const run = this.requireActiveRun();
    this.document.timeline.splice(run.user_entry_index + 1);
    run.assistant_entry_id = null;
    run.block_ids_by_content_index.clear();
    run.unresolved_tool_blocks.clear();
  }

  private replaceAssistantBlock(block: AssistantBlock): void {
    for (const entry of this.document.timeline) {
      if (entry.type !== "assistant_message") continue;
      const index = entry.blocks.findIndex(
        (candidate) => candidate.block_id === block.block_id,
      );
      if (index === -1) continue;
      entry.blocks[index] = block;
      return;
    }
    throw new Error(`Assistant block does not exist: ${block.block_id}`);
  }

  private requireActiveRun(): ActiveRun {
    if (!this.activeRun) {
      throw new Error("No active agent run is available.");
    }
    return this.activeRun;
  }

  private requireActiveAssistantEntry(): AssistantMessageEntry {
    const entryId = this.requireActiveRun().assistant_entry_id;
    if (!entryId) {
      throw new Error("No assistant message is currently streaming.");
    }
    return this.requireAssistantEntry(entryId);
  }

  private requireAssistantEntry(entryId: string): AssistantMessageEntry {
    const entry = this.document.timeline.find(
      (candidate) => candidate.entry_id === entryId,
    );
    if (!entry || entry.type !== "assistant_message") {
      throw new Error(`Assistant timeline entry does not exist: ${entryId}`);
    }
    return entry;
  }

  private requireAssistantBlock(blockId: string): AssistantBlock {
    for (const entry of this.document.timeline) {
      if (entry.type !== "assistant_message") continue;
      const block = entry.blocks.find(
        (candidate) => candidate.block_id === blockId,
      );
      if (block) return block;
    }
    throw new Error(`Assistant block does not exist: ${blockId}`);
  }

  private requireAssistantEntryIdForBlock(blockId: string): string {
    for (const entry of this.document.timeline) {
      if (
        entry.type === "assistant_message" &&
        entry.blocks.some((block) => block.block_id === blockId)
      ) {
        return entry.entry_id;
      }
    }
    throw new Error(`Assistant block does not exist: ${blockId}`);
  }

  private requireContentBlockId(contentIndex: number): string {
    const blockId =
      this.requireActiveRun().block_ids_by_content_index.get(contentIndex);
    if (!blockId) {
      throw new Error(
        `Assistant content index ${contentIndex} has not started.`,
      );
    }
    return blockId;
  }

  private reserveContentBlockId(contentIndex: number): string {
    const blockIds = this.requireActiveRun().block_ids_by_content_index;
    if (blockIds.has(contentIndex)) {
      throw new Error(
        `Assistant content index ${contentIndex} has already started.`,
      );
    }
    const blockId = crypto.randomUUID();
    blockIds.set(contentIndex, blockId);
    return blockId;
  }

  private requireContentIndexForBlockId(blockId: string): number {
    for (const [
      contentIndex,
      candidateBlockId,
    ] of this.requireActiveRun().block_ids_by_content_index) {
      if (candidateBlockId === blockId) return contentIndex;
    }
    throw new Error(`Assistant block ${blockId} has no content index.`);
  }

  private requireUnresolvedToolCall(
    toolCallId: string,
    toolName: string,
  ): ToolCallBlock {
    const blockId =
      this.requireActiveRun().unresolved_tool_blocks.get(toolCallId);
    const block = blockId ? this.requireAssistantBlock(blockId) : undefined;
    if (
      !block ||
      block.type !== "tool_call" ||
      block.tool_name !== toolName
    ) {
      throw new Error(
        `Tool call ${toolCallId} is missing its timeline identity.`,
      );
    }
    return block;
  }

  private hasToolResult(blockId: string): boolean {
    return this.document.timeline.some(
      (entry) =>
        entry.type === "tool_result" &&
        entry.tool_call_block_id === blockId,
    );
  }

  private activeRequestId(): string {
    const requestId = this.activeRun?.request_id;
    if (!requestId) throw new Error("No active agent run is available.");
    return requestId;
  }

  private createChangeMetadata(
    toolCallId: string,
    toolName: MutationToolName,
  ): WorkspaceChangeMetadata {
    const run = this.activeRun;
    if (!run) throw new Error("No active agent run is available.");
    return {
      change_id: crypto.randomUUID(),
      session_id: this.session_id,
      tool_call_block_id: this.requireUnresolvedToolCall(
        toolCallId,
        toolName,
      ).block_id,
      assistant_message_index: this.findAssistantMessageIndex(
        toolCallId,
        toolName,
      ),
      tool_call_id: toolCallId,
      tool_name: toolName,
      created_at: new Date().toISOString(),
    };
  }

  private findAssistantMessageIndex(
    toolCallId: string,
    toolName: MutationToolName,
  ): number {
    for (
      let index = this.agent.state.messages.length - 1;
      index >= 0;
      index -= 1
    ) {
      const message = this.agent.state.messages[index];
      if (message?.role !== "assistant") continue;
      if (
        message.content.some(
          (content) =>
            content.type === "toolCall" &&
            content.id === toolCallId &&
            content.name === toolName,
        )
      ) {
        return index;
      }
    }
    throw new Error(
      `Tool call ${toolCallId} is missing from the agent transcript.`,
    );
  }

  private fileMutationResult(
    mutation: FileMutationResult,
    requestId: string,
  ): {
    content: [{ type: "text"; text: string }];
    details: WorkspaceToolDetails;
  } {
    const result = mutation.result;
    if (!result) {
      throw new Error(
        "The workspace mutation did not return its journaled result.",
      );
    }
    const record = result.change;
    if (result.change_kind === "unchanged") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: result.path,
              change_kind: "unchanged",
            }),
          },
        ],
        details: { summary: "No changes needed" },
      };
    }
    if (!record) {
      throw new Error("The workspace mutation did not produce a change record.");
    }
    const fileChange = workspaceChangeSummary(record);
    this.emit(
      "workspace_changed",
      {
        workspace_revision: mutation.workspace_revision,
        change: fileChange,
      },
      requestId,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(fileChange),
        },
      ],
      details: {
        summary: changeSummary(fileChange),
        file_change: fileChange,
      },
    };
  }

  private emit<T extends CoreEvent["type"]>(
    type: T,
    payload: Omit<
      Extract<CoreEvent, { type: T }>["payload"],
      "project_id" | "session_id"
    >,
    requestId?: string,
  ): void {
    this.eventSink({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      ...(requestId === undefined ? {} : { request_id: requestId }),
      type,
      payload: {
        project_id: this.project_id,
        session_id: this.session_id,
        ...payload,
      },
    } as unknown as Extract<CoreEvent, { type: T }>);
  }

  private emitError(code: string, message: string, requestId?: string): void {
    this.eventSink({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      ...(requestId === undefined ? {} : { request_id: requestId }),
      type: "error",
      payload: {
        code,
        message,
        project_id: this.project_id,
        session_id: this.session_id,
      },
    });
  }

  private emitPersistenceError(error: unknown, requestId?: string): void {
    this.emitError(
      "persistence_failed",
      toErrorMessage(error, "The session could not be saved."),
      requestId,
    );
  }
}

function resolvePluginModel(
  options: Pick<SessionRuntimeOptions, "model" | "resolve_model">,
  selection: ModelSelection | undefined,
): Model<string> {
  if (!selection) return options.model;
  const model = options.resolve_model?.(selection);
  if (!model) {
    throw new Error(
      `Summary model is unavailable: ${selection.provider_id}/${selection.model_id}`,
    );
  }
  return model;
}

async function completePluginModel(
  transport: ModelTransport,
  model: Model<string>,
  sessionId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<{
  text: string;
  provider_id: string;
  model_id: string;
}> {
  const stream = createModelStreamFn(transport)(
    model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }],
    },
    {
      sessionId,
      signal,
    },
  );
  const response = await (await stream).result();
  if (response.stopReason === "aborted") {
    throw new DOMException("Model completion was cancelled.", "AbortError");
  }
  if (response.stopReason === "error") {
    throw new Error(
      response.errorMessage || "The model completion failed.",
    );
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("The model completion returned no text.");
  }
  return {
    text,
    provider_id: response.provider,
    model_id: response.model,
  };
}

function latestAssistantStopReason(agent: Agent): string | undefined {
  return [...agent.state.messages]
    .reverse()
    .find((message) => message.role === "assistant")?.stopReason;
}

function createTerminalAgentMessage(
  agent: Agent,
  status: "complete" | "aborted" | "error",
  errorMessage: string | undefined,
): AssistantMessage {
  const model = agent.state.model;
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
    stopReason: status === "complete" ? "stop" : status,
    ...(status === "error" && errorMessage
      ? { errorMessage }
      : {}),
    timestamp: Date.now(),
  };
}

export function stagePrompt(
  document: SessionDocument,
  text: string,
): StagedPrompt {
  const runId = crypto.randomUUID();
  const userEntry: UserMessageEntry = {
    type: "user_message",
    entry_id: crypto.randomUUID(),
    run_id: runId,
    content: text,
    created_at: new Date().toISOString(),
  };
  document.input_draft = "";
  document.timeline.push(userEntry);
  document.history = synchronizeSessionHistory(
    document.history,
    document.timeline,
  );
  return {
    user_entry: userEntry,
    run_id: runId,
  };
}

function createActiveRun(
  requestId: string,
  runId: string,
  userEntryIndex: number,
  transcriptBoundary: number,
): ActiveRun {
  return {
    request_id: requestId,
    run_id: runId,
    user_entry_index: userEntryIndex,
    abort_requested: false,
    transcript_boundary: transcriptBoundary,
    assistant_entry_id: null,
    block_ids_by_content_index: new Map(),
    unresolved_tool_blocks: new Map(),
  };
}

function toolLabel(toolName: string, args: unknown): string {
  const path =
    isRecord(args) && typeof args.path === "string"
      ? args.path
      : "workspace";
  switch (toolName) {
    case "list_files":
      return `Listing ${path}`;
    case "read_file":
      return `Reading ${path}`;
    case "search_files":
      return `Searching ${path}`;
    case "write_file":
      return `Writing ${path}`;
    case "replace_text":
      return `Editing ${path}`;
    case "remove_file":
      return `Removing ${path}`;
    case "run_python":
      return "Running Python";
    case "web_search":
      return "Searching web";
    case "open_url":
      return "Opening URL";
    default:
      return toolName
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ") || "Running tool";
  }
}

function toolProgressSummary(partialResult: unknown): string | null {
  if (!isRecord(partialResult) || !isRecord(partialResult.details)) {
    return null;
  }
  const summary = partialResult.details.summary;
  if (typeof summary !== "string") return null;
  const normalized = summary.trim();
  if (normalized.length === 0) return null;
  return normalized.slice(0, 240);
}

function isMutationToolName(value: string): value is MutationToolName {
  return (
    value === "write_file" ||
    value === "replace_text" ||
    value === "remove_file"
  );
}

function countOverlappingOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - search.length) {
    const index = value.indexOf(search, offset);
    if (index === -1) break;
    count += 1;
    offset = index + 1;
  }
  return count;
}

function workspaceChangeSummary(
  record: WorkspaceChangeRecord,
): WorkspaceChangeSummary {
  return {
    change_id: record.change_id,
    tool_call_id: record.tool_call_id,
    tool_name: record.tool_name,
    path: record.path,
    change_kind: record.change_kind,
    additions: record.additions,
    deletions: record.deletions,
    byte_size: record.byte_size,
  };
}

function changeSummary(change: WorkspaceChangeSummary): string {
  const verb =
    change.change_kind === "created"
      ? "Created"
      : change.change_kind === "updated"
        ? "Updated"
        : "Deleted";
  return `${verb} · +${change.additions} −${change.deletions}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
