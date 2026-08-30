import type { Model } from "@earendil-works/pi-ai";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  ReasoningEffortId,
  type LlmCallConfig,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import {
  createDshrboxCore,
  type DshrboxCore,
  type DshrboxPluginRegistration,
} from "@dshrbox/core";
import {
  DshrboxEventProjection,
} from "@dshrbox/event-projector";
import { ModelTransportLlmAdapter } from "@dshrbox/model-adapter";
import {
  DSHRBOX_RUNTIME_ID,
  DshrboxSessionPersistence,
  type DshrboxSessionBackend,
} from "@dshrbox/session-persistence";
import { DshrboxSummaryReview } from "@dshrbox/summary-review";
import { DshrboxWorkspace } from "@dshrbox/workspace";
import type {
  SessionRuntimeOptions,
  SessionRuntimePort,
  SessionRuntimeProvider,
  SessionRuntimeView,
} from "@researchbox/agent-core";
import {
  RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION,
  type LegacySessionDocument,
  type RuntimeSessionDocument,
  type SessionDocument,
} from "@researchbox/project-store";
import type {
  CoreEvent,
  ReasoningEffort,
  SummaryReviewResolution,
} from "@researchbox/protocol";
import { createDshrboxWorkspaceRecoveryBackend } from "./workspace-recovery.ts";

export type DshrboxSessionRuntimeProviderConfig = {
  session_backend: DshrboxSessionBackend;
  api?: string;
  max_parallel_tool_calls?: number;
  prepared_session_cache_size?: number;
  plugins?: readonly DshrboxPluginRegistration[];
  write_batch_max_delay_ms?: number;
};

/** Marks new sessions for DSH and creates their runtime implementation. */
export class DshrboxSessionRuntimeProvider implements SessionRuntimeProvider {
  readonly runtime_id = DSHRBOX_RUNTIME_ID;

  private readonly config: DshrboxSessionRuntimeProviderConfig;

  constructor(config: DshrboxSessionRuntimeProviderConfig) {
    assertProviderConfig(config);
    this.config = snapshotProviderConfig(config);
  }

  initializeDocument(
    document: LegacySessionDocument,
  ): RuntimeSessionDocument {
    if (document.timeline.length > 0) {
      throw new Error("Only a new empty session can be initialized for DSH.");
    }
    return {
      format_version: RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION,
      session_id: document.session_id,
      project_id: document.project_id,
      input_draft: document.input_draft,
      runtime_id: DSHRBOX_RUNTIME_ID,
      message_count: 0,
    };
  }

  create(options: SessionRuntimeOptions): Promise<SessionRuntimePort> {
    return DshrboxSessionRuntime.create(options, this.config);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.config.session_backend.deleteStored(SessionId(sessionId));
  }
}

class DshrboxSessionRuntime implements SessionRuntimePort {
  readonly project_id: string;
  readonly session_id: string;

  private readonly core: DshrboxCore;
  private readonly model: Model<string>;
  private readonly eventSink: SessionRuntimeOptions["event_sink"];
  private readonly checkpoint: SessionRuntimeOptions["checkpoint"];
  private document: RuntimeSessionDocument;
  private readonly projectedView: SessionRuntimeView;
  private activeRequestId: string | null = null;
  private activeRun: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;

  private constructor(core: DshrboxCore, options: SessionRuntimeOptions) {
    this.core = core;
    this.project_id = options.project_id;
    this.session_id = options.session_id;
    this.document = requireDshDocument(options.document);
    this.projectedView = {
      input_draft: this.document.input_draft,
      timeline: [],
    };
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
        "Legacy AgentPlugin values cannot be installed in DSH; configure native DSH plugins on DshrboxSessionRuntimeProvider.",
      );
    }
    const persistedRevision = await config.session_backend.readStoredRevision(
      SessionId(options.session_id),
    );
    const sessionBackend = persistedRevision === undefined
      ? config.session_backend
      : createDshrboxWorkspaceRecoveryBackend(
          config.session_backend,
          {
            session_id: options.session_id,
            workspace: options.workspace,
          },
        );
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
      resume: persistedRevision !== undefined,
      persona: options.system_prompt,
      ...(config.max_parallel_tool_calls === undefined
        ? {}
        : { max_parallel_tool_calls: config.max_parallel_tool_calls }),
      plugins: [
        {
          plugin: DshrboxSessionPersistence,
          config: {
            backend: sessionBackend,
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
          plugin: DshrboxSummaryReview,
          config: {
            project_id: options.project_id,
            session_id: options.session_id,
            event_sink: options.event_sink,
          },
        },
        ...(config.plugins ?? []),
        {
          plugin: DshrboxEventProjection,
          config: {
            project_id: options.project_id,
            session_id: options.session_id,
            ...(config.api === undefined ? {} : { api: config.api }),
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
    runtime.reconcileProjection();
    return runtime;
  }

  get is_running(): boolean {
    return this.core.runtime.agent.status === "running";
  }

  get is_busy(): boolean {
    return this.activeRun !== null || this.is_running;
  }

  view(): SessionRuntimeView {
    return this.projectedView;
  }

  usesModel(model: Model<string>): boolean {
    return model.provider === this.model.provider && model.id === this.model.id;
  }

  bindDocument(document: SessionDocument): void {
    if (this.is_busy) {
      throw new Error("Cannot replace a DSH document while a run is active.");
    }
    this.document = requireDshDocument(document);
    this.projectedView.input_draft = document.input_draft;
  }

  startPrompt(text: string, requestId: string): Promise<void> {
    return this.startRun(text, requestId);
  }

  continueStagedPrompt(
    runId: string,
    requestId: string,
  ): Promise<void> {
    void runId;
    void requestId;
    return Promise.reject(
      new Error("DSH sessions do not persist staged timeline prompts."),
    );
  }

  abort(): void {
    try {
      this.core.context.dshrboxSummaryReview.cancel();
    } finally {
      this.core.runtime.cancel();
    }
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
    this.core.context.dshrboxSummaryReview.resolve(
      interactionId,
      resolution,
    );
  }

  touchSummaryReview(interactionId: string): boolean {
    return this.core.context.dshrboxSummaryReview.touch(interactionId);
  }

  setSummaryReviewVisibility(
    interactionId: string,
    isVisible: boolean,
  ): boolean {
    return this.core.context.dshrboxSummaryReview.setVisibility(
      interactionId,
      isVisible,
    );
  }

  private startRun(
    text: string,
    requestId: string,
  ): Promise<void> {
    if (this.activeRun !== null) {
      return Promise.reject(new Error("The DSH session already has an active run."));
    }
    this.activeRequestId = requestId;
    try {
      this.core.context.dshrboxSummaryReview.beginRequest(requestId);
    } catch (error) {
      this.activeRequestId = null;
      return Promise.reject(error);
    }
    this.projectedView.input_draft = "";
    const run = this.executeRun(text).finally(() => {
      try {
        this.core.context.dshrboxSummaryReview.endRequest();
      } finally {
        if (this.activeRun === run) this.activeRun = null;
        this.activeRequestId = null;
      }
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
    return this.checkpoint(phase, requestId);
  }

  private acceptProjectedEvent(event: CoreEvent): void {
    const requestId = this.activeRequestId;
    if (requestId === null) {
      throw new Error("A live DSH projection has no active viewer request.");
    }
    const projected = { ...event, request_id: requestId } as CoreEvent;
    applyCoreEvent(this.projectedView, projected);
    this.eventSink(projected);
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
    this.projectedView.timeline = structuredClone(snapshot.timeline);
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

function applyCoreEvent(view: SessionRuntimeView, event: CoreEvent): void {
  switch (event.type) {
    case "timeline_entry_appended":
      if (
        view.timeline.some(
          (entry) => entry.entry_id === event.payload.entry.entry_id,
        )
      ) {
        throw new Error(
          `Duplicate projected timeline entry: ${event.payload.entry.entry_id}.`,
        );
      }
      view.timeline.push(structuredClone(event.payload.entry));
      return;
    case "timeline_entry_updated": {
      const index = requireTimelineIndex(
        view,
        event.payload.entry.entry_id,
      );
      view.timeline[index] = structuredClone(event.payload.entry);
      return;
    }
    case "assistant_block_appended": {
      const assistant = requireAssistantEntry(view, event.payload.entry_id);
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
      const assistant = requireAssistantEntry(view, event.payload.entry_id);
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
      const assistant = requireAssistantEntry(view, event.payload.entry_id);
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
  view: SessionRuntimeView,
  entryId: string,
): number {
  const index = view.timeline.findIndex(
    (entry) => entry.entry_id === entryId,
  );
  if (index === -1) {
    throw new Error(`Projected timeline entry is missing: ${entryId}.`);
  }
  return index;
}

function requireAssistantEntry(
  view: SessionRuntimeView,
  entryId: string,
): Extract<SessionRuntimeView["timeline"][number], { type: "assistant_message" }> {
  const entry = view.timeline.find(
    (candidate) => candidate.entry_id === entryId,
  );
  if (entry?.type !== "assistant_message") {
    throw new Error(`Projected assistant entry is missing: ${entryId}.`);
  }
  return entry;
}

function assertProviderConfig(
  config: DshrboxSessionRuntimeProviderConfig,
): void {
  if (
    config === null ||
    typeof config !== "object" ||
    config.session_backend === null ||
    typeof config.session_backend !== "object"
  ) {
    throw new TypeError(
      "dshrbox session runtime requires a session_backend",
    );
  }
}

function snapshotProviderConfig(
  config: DshrboxSessionRuntimeProviderConfig,
): DshrboxSessionRuntimeProviderConfig {
  return {
    ...config,
    ...(config.plugins === undefined
      ? {}
      : {
          plugins: config.plugins.map((registration) => ({
            ...registration,
          })),
        }),
  };
}

function assertRuntimeOptions(options: SessionRuntimeOptions): void {
  if (
    options.document.format_version !== RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION ||
    options.document.runtime_id !== DSHRBOX_RUNTIME_ID ||
    options.document.session_id !== options.session_id ||
    options.document.project_id !== options.project_id
  ) {
    throw new Error("Invalid DSH session runtime document.");
  }
}

function requireDshDocument(
  document: SessionDocument,
): RuntimeSessionDocument {
  if (
    document.format_version !== RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION ||
    document.runtime_id !== DSHRBOX_RUNTIME_ID
  ) {
    throw new Error("Invalid DSH session runtime document.");
  }
  return document;
}
