import { Context, Service } from "@deepseek-ai/cordis";
import {
  PROTOCOL_VERSION,
  type CoreEvent,
  type SummaryReviewRequest,
  type SummaryReviewResolution,
} from "@researchbox/protocol";

export type DshrboxSummaryReviewConfig = Readonly<{
  event_sink(event: CoreEvent): void;
  project_id: string;
  session_id: string;
}>;

export type DshrboxSummaryReviewInput = Omit<
  SummaryReviewRequest,
  "interaction_id"
>;

export type DshrboxSummaryReviewInteraction = Readonly<{
  resolution: Promise<SummaryReviewResolution>;
  isVisible(): boolean;
  subscribeActivity(listener: () => void): () => void;
  subscribeVisibility(listener: (isVisible: boolean) => void): () => void;
  update(request: DshrboxSummaryReviewInput): void;
}>;

type PendingSummaryReview = {
  activity_listeners: Set<() => void>;
  is_visible: boolean;
  on_abort?: () => void;
  reject(error: Error): void;
  request: SummaryReviewRequest;
  resolve(resolution: SummaryReviewResolution): void;
  signal?: AbortSignal;
  visibility_listeners: Set<(isVisible: boolean) => void>;
};

declare module "@deepseek-ai/cordis" {
  interface Context {
    dshrboxSummaryReview: DshrboxSummaryReview;
  }
}

/** Owns one session's live, non-durable summary-review interaction. */
export class DshrboxSummaryReview extends Service {
  private activeRequestId: string | null = null;
  private readonly config: DshrboxSummaryReviewConfig;
  private disposed = false;
  private pending: PendingSummaryReview | null = null;

  constructor(ctx: Context, config: DshrboxSummaryReviewConfig) {
    assertConfig(config);
    super(ctx, "dshrboxSummaryReview");
    this.config = config;
    ctx.effect(() => () => {
      this.disposed = true;
      this.cancelPending(createAbortError("Summary review was disposed."));
      this.activeRequestId = null;
    }, "dshrboxSummaryReview.lifecycle()");
  }

  beginRequest(requestId: string): void {
    if (this.disposed) {
      throw new Error("The summary-review service is disposed.");
    }
    if (requestId.length === 0) {
      throw new Error("Summary review requires a request id.");
    }
    if (this.activeRequestId !== null) {
      throw new Error("Another summary-review request is already active.");
    }
    this.activeRequestId = requestId;
  }

  endRequest(): void {
    if (this.activeRequestId === null) return;
    this.cancelPending(createAbortError("Summary review was cancelled."));
    this.activeRequestId = null;
  }

  request(
    request: DshrboxSummaryReviewInput,
    signal?: AbortSignal,
  ): Promise<SummaryReviewResolution> {
    try {
      return this.open(request, signal).resolution;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  open(
    request: DshrboxSummaryReviewInput,
    signal?: AbortSignal,
  ): DshrboxSummaryReviewInteraction {
    const requestId = this.requireActiveRequest();
    if (this.pending !== null) {
      throw new Error("Another summary review is already pending.");
    }
    if (signal?.aborted) {
      throw createAbortError("Summary review was cancelled.");
    }

    const interactionId = crypto.randomUUID();
    const review = cloneRequest(request, interactionId);
    const resolution = new Promise<SummaryReviewResolution>(
      (resolve, reject) => {
        const pending: PendingSummaryReview = {
          activity_listeners: new Set(),
          is_visible: true,
          reject,
          request: review,
          resolve,
          signal,
          visibility_listeners: new Set(),
        };
        if (signal !== undefined) {
          pending.on_abort = () => {
            if (this.pending !== pending) return;
            this.cancelPending(
              createAbortError("Summary review was cancelled."),
            );
          };
          signal.addEventListener("abort", pending.on_abort, { once: true });
        }
        this.pending = pending;
      },
    );
    this.emitRequest("summary_review_requested", review, requestId);

    return {
      resolution,
      isVisible: () => this.isVisible(interactionId),
      subscribeActivity: (listener) =>
        this.subscribeActivity(interactionId, listener),
      subscribeVisibility: (listener) =>
        this.subscribeVisibility(interactionId, listener),
      update: (updatedRequest) =>
        this.update(interactionId, updatedRequest),
    };
  }

  resolve(
    interactionId: string,
    resolution: SummaryReviewResolution,
  ): void {
    const pending = this.requirePending(interactionId);
    validateResolution(pending.request, resolution);
    this.clearPending();
    pending.resolve(structuredClone(resolution));
  }

  touch(interactionId: string): boolean {
    const pending = this.findPending(interactionId);
    if (pending === null) return false;
    notifyListeners(pending.activity_listeners, (listener) => listener());
    return true;
  }

  setVisibility(interactionId: string, isVisible: boolean): boolean {
    const pending = this.findPending(interactionId);
    if (pending === null) return false;
    if (pending.is_visible === isVisible) return true;
    pending.is_visible = isVisible;
    notifyListeners(
      pending.visibility_listeners,
      (listener) => listener(isVisible),
    );
    return true;
  }

  cancel(error = createAbortError("Summary review was cancelled.")): void {
    this.cancelPending(error);
  }

  private update(
    interactionId: string,
    request: DshrboxSummaryReviewInput,
  ): void {
    const requestId = this.requireActiveRequest();
    const pending = this.requirePending(interactionId);
    const review = cloneRequest(request, interactionId);
    pending.request = review;
    this.emitRequest("summary_review_updated", review, requestId);
  }

  private isVisible(interactionId: string): boolean {
    return this.findPending(interactionId)?.is_visible ?? false;
  }

  private subscribeActivity(
    interactionId: string,
    listener: () => void,
  ): () => void {
    const pending = this.findPending(interactionId);
    if (pending === null) return () => undefined;
    pending.activity_listeners.add(listener);
    return () => pending.activity_listeners.delete(listener);
  }

  private subscribeVisibility(
    interactionId: string,
    listener: (isVisible: boolean) => void,
  ): () => void {
    const pending = this.findPending(interactionId);
    if (pending === null) return () => undefined;
    pending.visibility_listeners.add(listener);
    return () => pending.visibility_listeners.delete(listener);
  }

  private cancelPending(error: Error): void {
    const pending = this.pending;
    if (pending === null) return;
    const requestId = this.activeRequestId;
    this.clearPending();
    try {
      if (requestId !== null) {
        this.emitResolved(pending.request.interaction_id, requestId);
      }
    } finally {
      pending.reject(error);
    }
  }

  private clearPending(): void {
    const pending = this.pending;
    if (pending === null) return;
    if (pending.signal !== undefined && pending.on_abort !== undefined) {
      pending.signal.removeEventListener("abort", pending.on_abort);
    }
    pending.activity_listeners.clear();
    pending.visibility_listeners.clear();
    this.pending = null;
  }

  private findPending(interactionId: string): PendingSummaryReview | null {
    return this.pending?.request.interaction_id === interactionId
      ? this.pending
      : null;
  }

  private requirePending(interactionId: string): PendingSummaryReview {
    const pending = this.findPending(interactionId);
    if (pending === null) {
      throw new Error("The summary review is no longer pending.");
    }
    return pending;
  }

  private requireActiveRequest(): string {
    if (this.disposed) {
      throw new Error("The summary-review service is disposed.");
    }
    if (this.activeRequestId === null) {
      throw new Error("Summary review requires an active agent request.");
    }
    return this.activeRequestId;
  }

  private emitRequest(
    type: "summary_review_requested" | "summary_review_updated",
    request: SummaryReviewRequest,
    requestId: string,
  ): void {
    this.config.event_sink({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      request_id: requestId,
      type,
      payload: {
        project_id: this.config.project_id,
        session_id: this.config.session_id,
        ...structuredClone(request),
      },
    });
  }

  private emitResolved(interactionId: string, requestId: string): void {
    this.config.event_sink({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      request_id: requestId,
      type: "summary_review_resolved",
      payload: {
        project_id: this.config.project_id,
        session_id: this.config.session_id,
        interaction_id: interactionId,
        decision: "dismiss",
      },
    });
  }
}

export default DshrboxSummaryReview;

function cloneRequest(
  request: DshrboxSummaryReviewInput,
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
    summary_model: request.summary_model === null
      ? null
      : { ...request.summary_model },
    draft_metadata: request.draft_metadata === null
      ? null
      : structuredClone(request.draft_metadata),
    query_draft: request.query_draft,
    query_notice: request.query_notice,
    search_providers: structuredClone(request.search_providers),
    search_provider: request.search_provider,
    sections: structuredClone(request.sections),
    selected_section_ids: [...request.selected_section_ids],
  };
}

function validateResolution(
  request: SummaryReviewRequest,
  resolution: SummaryReviewResolution,
): void {
  const allowedWhileLoading = request.loading_phase === "search"
    ? resolution.decision === "change-provider" ||
      resolution.decision === "dismiss"
    : request.loading_phase === "summary-grace" ||
        request.loading_phase === "summary"
    ? resolution.decision === "change-provider" ||
      resolution.decision === "add-search" ||
      resolution.decision === "dismiss"
    : false;
  if (
    request.is_loading &&
    resolution.decision !== "cancel" &&
    !allowedWhileLoading
  ) {
    throw new Error(
      "The summary review cannot be submitted while it is loading.",
    );
  }

  const availableIds = new Set(
    request.sections.map((section) => section.section_id),
  );
  const selectableIds = new Set(
    request.sections
      .filter((section) => section.is_selectable)
      .map((section) => section.section_id),
  );
  const providerIds = new Set(
    request.search_providers.map((provider) => provider.provider_id),
  );
  if (
    resolution.search_provider !== null &&
    !providerIds.has(resolution.search_provider)
  ) {
    throw new Error(
      "The summary review selected an unavailable search provider.",
    );
  }
  if (
    resolution.decision === "change-provider" &&
    resolution.search_provider === null
  ) {
    throw new Error("The summary review requires a search provider.");
  }
  if (
    resolution.selected_section_ids.some(
      (sectionId) =>
        !availableIds.has(sectionId) || !selectableIds.has(sectionId),
    )
  ) {
    throw new Error("The summary review selected an unavailable section.");
  }
  if (
    request.stage !== "select-evidence" &&
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
}

function notifyListeners<T>(
  listeners: Set<T>,
  notify: (listener: T) => void,
): void {
  for (const listener of [...listeners]) {
    try {
      notify(listener);
    } catch {
      // Interaction observers must not break application command handling.
    }
  }
}

function assertConfig(config: DshrboxSummaryReviewConfig): void {
  if (config === null || typeof config !== "object") {
    throw new TypeError("dshrbox summary-review config must be an object");
  }
  if (typeof config.event_sink !== "function") {
    throw new TypeError("dshrbox summary review requires an event_sink");
  }
  if (
    typeof config.project_id !== "string" ||
    config.project_id.length === 0 ||
    typeof config.session_id !== "string" ||
    config.session_id.length === 0
  ) {
    throw new TypeError("dshrbox summary review requires session scope");
  }
}

function createAbortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}
