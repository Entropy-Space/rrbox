import type { Model } from "@earendil-works/pi-ai";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  ReasoningEffortId,
  type LlmCallConfig,
} from "@deepseek-ai/dsh-llm";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import {
  createDshrboxCore,
  type DshrboxCore,
} from "@dshrbox/core";
import {
  DshrboxEventProjection,
  type DshrboxProjectionSnapshot,
} from "@dshrbox/event-projector";
import { ModelTransportLlmAdapter } from "@dshrbox/model-adapter";
import {
  DSHRBOX_RUNTIME_ID,
  DSHRBOX_RUNTIME_STATE_FORMAT_VERSION,
  DshrboxSessionPersistence,
  readDshrboxPersistedSession,
} from "@dshrbox/session-persistence";
import { DshrboxWorkspace } from "@dshrbox/workspace";
import type {
  SessionRuntimeOptions,
  SessionRuntimePort,
  SessionRuntimeProvider,
} from "@researchbox/agent-core";
import {
  synchronizeSessionHistory,
  type ProjectStore,
  type SessionDocument,
} from "@researchbox/project-store";
import type {
  CoreEvent,
  ReasoningEffort,
  SummaryReviewResolution,
  TimelineEntry,
} from "@researchbox/protocol";

export type DshrboxSessionRuntimeProviderConfig = {
  project_store: ProjectStore;
  api?: string;
  max_parallel_tool_calls?: number;
  prepared_session_cache_size?: number;
  write_batch_max_delay_ms?: number;
};

/** Marks new sessions for DSH and creates their runtime implementation. */
export class DshrboxSessionRuntimeProvider implements SessionRuntimeProvider {
  readonly runtime_id = DSHRBOX_RUNTIME_ID;

  private readonly config: DshrboxSessionRuntimeProviderConfig;

  constructor(config: DshrboxSessionRuntimeProviderConfig) {
    assertProviderConfig(config);
    this.config = config;
  }

  initializeDocument(document: SessionDocument): void {
    if (document.timeline.length > 0 || document.runtime_state !== undefined) {
      throw new Error("Only a new empty session can be initialized for DSH.");
    }
    document.runtime_state = {
      runtime_id: DSHRBOX_RUNTIME_ID,
      format_version: DSHRBOX_RUNTIME_STATE_FORMAT_VERSION,
      payload: null,
    };
  }

  create(options: SessionRuntimeOptions): Promise<SessionRuntimePort> {
    return DshrboxSessionRuntime.create(options, this.config);
  }
}

type StagedAlias = {
  projected_entry_id: string;
  projected_run_id: string;
  stored_created_at: string;
  stored_entry_id: string;
  stored_run_id: string;
};

class DshrboxSessionRuntime implements SessionRuntimePort {
  readonly project_id: string;
  readonly session_id: string;

  private readonly core: DshrboxCore;
  private readonly model: Model<string>;
  private readonly eventSink: SessionRuntimeOptions["event_sink"];
  private readonly checkpoint: SessionRuntimeOptions["checkpoint"];
  private document: SessionDocument;
  private activeRequestId: string | null = null;
  private activeRun: Promise<void> | null = null;
  private pendingStagedEntry: Extract<
    TimelineEntry,
    { type: "user_message" }
  > | null = null;
  private stagedAlias: StagedAlias | null = null;
  private disposal: Promise<void> | null = null;

  private constructor(core: DshrboxCore, options: SessionRuntimeOptions) {
    this.core = core;
    this.project_id = options.project_id;
    this.session_id = options.session_id;
    this.document = options.document;
    this.model = options.model;
    this.eventSink = options.event_sink;
    this.checkpoint = options.checkpoint;
  }

  static async create(
    options: SessionRuntimeOptions,
    config: DshrboxSessionRuntimeProviderConfig,
  ): Promise<DshrboxSessionRuntime> {
    assertRuntimeOptions(options);
    if ((options.plugins?.length ?? 0) > 0) {
      throw new Error(
        "Legacy AgentPlugin values must be adapted as DSH plugins before use.",
      );
    }
    const persisted = readDshrboxPersistedSession(options.document);
    let runtime: DshrboxSessionRuntime | null = null;
    const checkpointPolicy = createCheckpointPolicy({
      session_id: options.session_id,
      reasoning_effort: options.reasoning_effort,
      checkpoint: (phase) => {
        if (runtime === null) {
          throw new Error("The DSH session runtime is not ready.");
        }
        return runtime.checkpointPhase(phase);
      },
    });
    const core = await createDshrboxCore({
      llm_adapter: new ModelTransportLlmAdapter(
        options.model_transport,
        createModelCatalog(options.model),
      ),
      model: options.model.id,
      provider: options.model.provider,
      session_id: options.session_id,
      resume: persisted !== null,
      persona: options.system_prompt,
      ...(config.max_parallel_tool_calls === undefined
        ? {}
        : { max_parallel_tool_calls: config.max_parallel_tool_calls }),
      plugins: [
        {
          plugin: DshrboxSessionPersistence,
          config: {
            project_store: config.project_store,
            ...(config.prepared_session_cache_size === undefined
              ? {}
              : {
                  prepared_session_cache_size:
                    config.prepared_session_cache_size,
                }),
            ...(config.write_batch_max_delay_ms === undefined
              ? {}
              : {
                  write_batch_max_delay_ms:
                    config.write_batch_max_delay_ms,
                }),
          },
        },
        {
          plugin: DshrboxWorkspace,
          config: { workspace: options.workspace },
        },
        {
          plugin: DshrboxEventProjection,
          config: {
            project_id: options.project_id,
            session_id: options.session_id,
            ...(config.api === undefined ? {} : { api: config.api }),
            ...(persisted === null
              ? {}
              : { seed_events: persisted.events }),
            event_sink: (event: CoreEvent) => {
              if (runtime === null) {
                throw new Error("The DSH session runtime is not ready.");
              }
              runtime.acceptProjectedEvent(event);
            },
          },
        },
        { plugin: checkpointPolicy },
      ],
    });
    runtime = new DshrboxSessionRuntime(core, options);
    runtime.catchUpProjection();
    if (persisted !== null) runtime.reconcileProjection();
    return runtime;
  }

  get is_running(): boolean {
    return this.core.runtime.agent.status === "running";
  }

  get is_busy(): boolean {
    return this.activeRun !== null || this.is_running;
  }

  ownedDocument(): SessionDocument {
    return this.document;
  }

  usesModel(model: Model<string>): boolean {
    return model.provider === this.model.provider && model.id === this.model.id;
  }

  bindDocument(document: SessionDocument): void {
    if (this.is_busy) {
      throw new Error("Cannot replace a DSH document while a run is active.");
    }
    this.document = document;
    this.reconcileProjection();
  }

  startPrompt(text: string, requestId: string): Promise<void> {
    return this.startRun(text, requestId, null);
  }

  continueStagedPrompt(
    runId: string,
    requestId: string,
  ): Promise<void> {
    const staged = this.document.timeline.findLast(
      (entry): entry is Extract<TimelineEntry, { type: "user_message" }> =>
        entry.type === "user_message" && entry.run_id === runId,
    );
    if (staged === undefined) {
      return Promise.reject(new Error("The staged DSH prompt is unavailable."));
    }
    return this.startRun(staged.content, requestId, staged);
  }

  abort(): void {
    this.core.runtime.cancel();
  }

  async stopAndWait(): Promise<void> {
    this.abort();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    await this.activeRun;
    await this.core.runtime.agent.whenIdle();
  }

  dispose(): Promise<void> {
    if (this.disposal !== null) return this.disposal;
    this.disposal = this.core.dispose();
    return this.disposal;
  }

  resolveSummaryReview(
    interactionId: string,
    resolution: SummaryReviewResolution,
  ): void {
    void interactionId;
    void resolution;
    throw new Error("DSH summary-review plugins are not installed.");
  }

  touchSummaryReview(interactionId: string): boolean {
    void interactionId;
    return false;
  }

  setSummaryReviewVisibility(
    interactionId: string,
    isVisible: boolean,
  ): boolean {
    void interactionId;
    void isVisible;
    return false;
  }

  private startRun(
    text: string,
    requestId: string,
    staged: Extract<TimelineEntry, { type: "user_message" }> | null,
  ): Promise<void> {
    if (this.activeRun !== null) {
      return Promise.reject(new Error("The DSH session already has an active run."));
    }
    this.activeRequestId = requestId;
    this.pendingStagedEntry = staged;
    this.stagedAlias = null;
    const run = this.executeRun(text).finally(() => {
      if (this.activeRun === run) this.activeRun = null;
      this.activeRequestId = null;
      this.pendingStagedEntry = null;
      this.stagedAlias = null;
    });
    this.activeRun = run;
    return run;
  }

  private async executeRun(text: string): Promise<void> {
    try {
      await this.core.runtime.run(text);
    } finally {
      await this.core.context.sessions.flush(this.core.runtime.agent.session);
      await this.checkpointPhase("finished");
    }
  }

  private checkpointPhase(
    phase: "staged" | "tool_started" | "tool_finished" | "finished",
  ): Promise<void> {
    const requestId = this.activeRequestId;
    if (requestId === null) {
      return Promise.reject(
        new Error(`DSH ${phase} checkpoint has no active request.`),
      );
    }
    return this.checkpoint(phase, requestId, this.document);
  }

  private acceptProjectedEvent(event: CoreEvent): void {
    const requestId = this.activeRequestId;
    if (requestId === null) {
      throw new Error("A live DSH projection has no active viewer request.");
    }
    if (event.type === "timeline_entry_appended") {
      const entry = structuredClone(event.payload.entry);
      if (entry.type === "user_message" && this.pendingStagedEntry !== null) {
        this.aliasStagedUser(entry, this.pendingStagedEntry);
        this.pendingStagedEntry = null;
        return;
      }
    }
    const projected = this.applyAliases(event, requestId);
    applyCoreEvent(this.document, projected);
    this.eventSink(projected);
  }

  private aliasStagedUser(
    projected: Extract<TimelineEntry, { type: "user_message" }>,
    stored: Extract<TimelineEntry, { type: "user_message" }>,
  ): void {
    if (projected.content !== stored.content) {
      throw new Error("The staged prompt does not match the DSH user message.");
    }
    this.stagedAlias = {
      projected_entry_id: projected.entry_id,
      projected_run_id: projected.run_id,
      stored_created_at: stored.created_at,
      stored_entry_id: stored.entry_id,
      stored_run_id: stored.run_id,
    };
  }

  private applyAliases(event: CoreEvent, requestId: string): CoreEvent {
    const alias = this.stagedAlias;
    const scope = { request_id: requestId };
    switch (event.type) {
      case "timeline_entry_appended":
      case "timeline_entry_updated":
        return {
          ...event,
          ...scope,
          payload: {
            ...event.payload,
            entry: alias === null
              ? structuredClone(event.payload.entry)
              : aliasTimelineEntry(event.payload.entry, alias),
          },
        };
      case "assistant_block_appended":
      case "assistant_block_delta":
      case "assistant_block_updated":
        return {
          ...event,
          ...scope,
          payload: {
            ...event.payload,
            entry_id: alias?.projected_entry_id === event.payload.entry_id
              ? alias.stored_entry_id
              : event.payload.entry_id,
          },
        } as CoreEvent;
      default:
        return { ...event, ...scope };
    }
  }

  private catchUpProjection(): void {
    const projection = this.core.context.dshrboxProjection;
    const expectedSeq = (projection.projector.last_event_seq ?? -1) + 1;
    projection.catchUp(
      this.core.runtime.agent.session.events.slice(expectedSeq),
    );
  }

  private reconcileProjection(): void {
    this.catchUpProjection();
    const snapshot = this.core.context.dshrboxProjection.snapshot();
    const alias = deriveStagedAlias(this.document.timeline, snapshot);
    this.document.timeline = alias === null
      ? structuredClone(snapshot.timeline)
      : snapshot.timeline.map((entry) => aliasTimelineEntry(entry, alias));
    this.document.history = synchronizeSessionHistory(
      this.document.history,
      this.document.timeline,
    );
  }
}

function createModelCatalog(model: Model<string>) {
  const capabilities = model as Model<string> & {
    reasoning_efforts?: ReasoningEffort[];
    supports_reasoning_effort?: boolean;
    supports_tools?: boolean;
  };
  const reasoningEfforts = (capabilities.reasoning_efforts ?? [])
    .filter((effort) => effort !== "default");
  return {
    async listModels(providerId: string) {
      if (providerId !== model.provider) return [];
      return [{
        provider_id: model.provider,
        provider_display_name: model.provider,
        model_id: model.id,
        display_name: model.name,
        context_window: model.contextWindow,
        max_output_tokens: model.maxTokens,
        supports_tools: capabilities.supports_tools ?? true,
        supports_reasoning: model.reasoning,
        supports_reasoning_effort:
          capabilities.supports_reasoning_effort === true ||
          reasoningEfforts.length > 0,
        reasoning_efforts: reasoningEfforts,
      }];
    },
  };
}

type CheckpointPhase =
  | "staged"
  | "tool_started"
  | "tool_finished";

type CheckpointPolicyConfig = {
  session_id: string;
  reasoning_effort: ReasoningEffort;
  checkpoint(phase: CheckpointPhase): Promise<void>;
};

function createCheckpointPolicy(config: CheckpointPolicyConfig): Plugin {
  const plugin = (ctx: Context): void => {
    ctx.on("agent/request", async (payload, next) => {
      if (String(payload.agent.id) !== config.session_id) return next();
      await ctx.sessions.flush(payload.agent.session);
      await config.checkpoint(
        payload.step === 1 ? "staged" : "tool_finished",
      );
      const proposed = await next();
      return applyReasoningEffort(proposed, config.reasoning_effort);
    });
    ctx.on("tools/pre-execute", async (execution, next) => {
      if (!isOwnedExecution(execution, config.session_id)) return next();
      await ctx.sessions.flush(execution.agent.session);
      await config.checkpoint("tool_started");
      return next();
    });
  };
  plugin.inject = ["sessions", "tools"];
  return plugin;
}

function applyReasoningEffort(
  config: LlmCallConfig,
  effort: ReasoningEffort,
): LlmCallConfig {
  const base = { ...config };
  delete base.reasoningEffort;
  if (effort === "default") return base;
  return {
    ...base,
    reasoningEffort: ReasoningEffortId(effort),
  };
}

function isOwnedExecution(
  execution: ToolExecution,
  sessionId: string,
): execution is ToolExecution & { agent: Agent } {
  return execution.agent !== undefined &&
    String(execution.agent.id) === sessionId;
}

function applyCoreEvent(document: SessionDocument, event: CoreEvent): void {
  switch (event.type) {
    case "timeline_entry_appended":
      if (
        document.timeline.some(
          (entry) => entry.entry_id === event.payload.entry.entry_id,
        )
      ) {
        throw new Error(
          `Duplicate projected timeline entry: ${event.payload.entry.entry_id}.`,
        );
      }
      document.timeline.push(structuredClone(event.payload.entry));
      return;
    case "timeline_entry_updated": {
      const index = requireTimelineIndex(
        document,
        event.payload.entry.entry_id,
      );
      document.timeline[index] = structuredClone(event.payload.entry);
      return;
    }
    case "assistant_block_appended": {
      const assistant = requireAssistantEntry(document, event.payload.entry_id);
      if (
        assistant.blocks.some(
          (block) => block.block_id === event.payload.block.block_id,
        )
      ) {
        throw new Error(
          `Duplicate projected assistant block: ${event.payload.block.block_id}.`,
        );
      }
      assistant.blocks.push(structuredClone(event.payload.block));
      return;
    }
    case "assistant_block_delta": {
      const assistant = requireAssistantEntry(document, event.payload.entry_id);
      const block = assistant.blocks.find(
        (candidate) => candidate.block_id === event.payload.block_id,
      );
      if (
        block === undefined ||
        block.type !== event.payload.block_type
      ) {
        throw new Error(
          `Projected assistant block is missing: ${event.payload.block_id}.`,
        );
      }
      block.text += event.payload.text_delta;
      return;
    }
    case "assistant_block_updated": {
      const assistant = requireAssistantEntry(document, event.payload.entry_id);
      const index = assistant.blocks.findIndex(
        (block) => block.block_id === event.payload.block.block_id,
      );
      if (index === -1) {
        throw new Error(
          `Projected assistant block is missing: ${event.payload.block.block_id}.`,
        );
      }
      assistant.blocks[index] = structuredClone(event.payload.block);
      return;
    }
    default:
      return;
  }
}

function requireTimelineIndex(
  document: SessionDocument,
  entryId: string,
): number {
  const index = document.timeline.findIndex(
    (entry) => entry.entry_id === entryId,
  );
  if (index === -1) {
    throw new Error(`Projected timeline entry is missing: ${entryId}.`);
  }
  return index;
}

function requireAssistantEntry(
  document: SessionDocument,
  entryId: string,
): Extract<TimelineEntry, { type: "assistant_message" }> {
  const entry = document.timeline.find(
    (candidate) => candidate.entry_id === entryId,
  );
  if (entry?.type !== "assistant_message") {
    throw new Error(`Projected assistant entry is missing: ${entryId}.`);
  }
  return entry;
}

function deriveStagedAlias(
  stored: readonly TimelineEntry[],
  snapshot: DshrboxProjectionSnapshot,
): StagedAlias | null {
  const projectedUser = snapshot.timeline.find(
    (entry): entry is Extract<TimelineEntry, { type: "user_message" }> =>
      entry.type === "user_message",
  );
  const storedUser = stored.find(
    (entry): entry is Extract<TimelineEntry, { type: "user_message" }> =>
      entry.type === "user_message",
  );
  if (
    projectedUser === undefined ||
    storedUser === undefined ||
    projectedUser.entry_id === storedUser.entry_id
  ) {
    return null;
  }
  if (projectedUser.content !== storedUser.content) {
    throw new Error("Persisted DSH history does not match its rrbox timeline.");
  }
  return {
    projected_entry_id: projectedUser.entry_id,
    projected_run_id: projectedUser.run_id,
    stored_created_at: storedUser.created_at,
    stored_entry_id: storedUser.entry_id,
    stored_run_id: storedUser.run_id,
  };
}

function aliasTimelineEntry(
  source: TimelineEntry,
  alias: StagedAlias,
): TimelineEntry {
  const entry = structuredClone(source);
  if (entry.run_id === alias.projected_run_id) {
    entry.run_id = alias.stored_run_id;
  }
  if (entry.entry_id === alias.projected_entry_id) {
    entry.entry_id = alias.stored_entry_id;
    entry.created_at = alias.stored_created_at;
  }
  return entry;
}

function assertProviderConfig(
  config: DshrboxSessionRuntimeProviderConfig,
): void {
  if (
    config === null ||
    typeof config !== "object" ||
    config.project_store === null ||
    typeof config.project_store !== "object"
  ) {
    throw new TypeError(
      "dshrbox session runtime requires a project_store",
    );
  }
}

function assertRuntimeOptions(options: SessionRuntimeOptions): void {
  if (
    options.document.runtime_state?.runtime_id !== DSHRBOX_RUNTIME_ID ||
    options.document.session_id !== options.session_id ||
    options.document.project_id !== options.project_id
  ) {
    throw new Error("Invalid DSH session runtime document.");
  }
}
