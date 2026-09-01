import type { ModelTransport } from "@researchbox/model-transport";
import type {
  LegacySessionDocument,
  SessionDocument,
  SessionHistory,
} from "@researchbox/project-store";
import type {
  CoreEvent,
  ModelSelection,
  ReasoningEffort,
  SummaryReviewResolution,
  TimelineEntry,
} from "@researchbox/protocol";
import type { RuntimeModel } from "./model.ts";
import type { WorkspaceController } from "./workspace-controller.ts";

export type CoreEventSink = (event: CoreEvent) => void;

export type SessionRuntimeOptions = {
  project_id: string;
  session_id: string;
  document: SessionDocument;
  /** Present only while a copy-on-write runtime seed is being materialized. */
  migration_source_document?: LegacySessionDocument;
  workspace: WorkspaceController;
  model_transport: ModelTransport;
  model: RuntimeModel;
  reasoning_effort: ReasoningEffort;
  resolve_model?: (selection: ModelSelection) => RuntimeModel | undefined;
  system_prompt: string;
  event_sink: CoreEventSink;
  checkpoint: (
    phase: "staged" | "tool_started" | "tool_finished" | "finished",
    requestId: string,
  ) => Promise<void>;
};

export type SessionRuntimeView = {
  input_draft: string;
  timeline: TimelineEntry[];
  history?: SessionHistory;
};

/** Runtime boundary owned by ResearchBoxCore's project/session coordinator. */
export interface SessionRuntimePort {
  readonly project_id: string;
  readonly session_id: string;
  readonly is_running: boolean;
  /** Includes persistence and checkpoint finalization after model execution. */
  readonly is_busy: boolean;
  /** Current host-view projection; it is not necessarily persisted. */
  view(): SessionRuntimeView;
  usesModel(model: RuntimeModel): boolean;
  bindDocument(document: SessionDocument): void;
  startPrompt(text: string, requestId: string): Promise<void>;
  continueStagedPrompt(runId: string, requestId: string): Promise<void>;
  abort(): void;
  stopAndWait(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void | Promise<void>;
  resolveSummaryReview(
    interactionId: string,
    resolution: SummaryReviewResolution,
  ): void;
  touchSummaryReview(interactionId: string): boolean;
  setSummaryReviewVisibility(
    interactionId: string,
    isVisible: boolean,
  ): boolean;
}

export type StagedLegacyPrompt = {
  run_id: string;
};

/** Explicit compatibility lane for unmarked, timeline-backed documents. */
export interface LegacySessionRuntimeProvider {
  stagePrompt(
    document: LegacySessionDocument,
    text: string,
  ): StagedLegacyPrompt;
  create(options: SessionRuntimeOptions):
    | SessionRuntimePort
    | Promise<SessionRuntimePort>;
}

/** Optional copy-on-write runtime for newly-created runtime references. */
export interface SessionRuntimeProvider {
  readonly runtime_id: string;
  initializeDocument(document: LegacySessionDocument): SessionDocument;
  /** Create a new runtime reference whose initial history is copied from source. */
  initializeMigrationDocument?(
    source: LegacySessionDocument,
    targetSessionId: string,
  ): SessionDocument;
  create(options: SessionRuntimeOptions):
    | SessionRuntimePort
    | Promise<SessionRuntimePort>;
  /** Idempotently removes runtime-owned persistence after host metadata commits. */
  deleteSession?(projectId: string, sessionId: string): void | Promise<void>;
}
