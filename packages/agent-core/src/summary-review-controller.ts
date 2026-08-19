import type {
  SummaryReviewRequest,
  SummaryReviewResolution,
} from "@researchbox/protocol";
import type { SummaryReviewInteraction } from "./agent-plugin.ts";

export type SummaryReviewControllerOptions = {
  is_run_active(): boolean;
  on_requested(request: SummaryReviewRequest): void;
  on_updated(request: SummaryReviewRequest): void;
  on_cancelled(interactionId: string): void;
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

/** Runtime-neutral owner for one interactive plugin summary review. */
export class SummaryReviewController {
  private readonly options: SummaryReviewControllerOptions;
  private pending: PendingSummaryReview | null = null;

  constructor(options: SummaryReviewControllerOptions) {
    this.options = options;
  }

  request(
    request: Omit<SummaryReviewRequest, "interaction_id">,
    signal?: AbortSignal,
  ): Promise<SummaryReviewResolution> {
    try {
      return this.open(request, signal).resolution;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  open(
    request: Omit<SummaryReviewRequest, "interaction_id">,
    signal?: AbortSignal,
  ): SummaryReviewInteraction {
    if (this.pending !== null) {
      throw new Error("Another summary review is already pending.");
    }
    if (!this.options.is_run_active()) {
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
        if (signal !== undefined) {
          pending.on_abort = () => {
            if (this.pending !== pending) return;
            this.clear();
            if (this.options.is_run_active()) {
              this.options.on_cancelled(interactionId);
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
        this.pending = pending;
      },
    );
    this.options.on_requested(structuredClone(review));
    return {
      resolution,
      is_visible: () =>
        this.pending?.request.interaction_id === interactionId
          ? this.pending.is_visible
          : false,
      subscribe_activity: (listener) => {
        const pending = this.requireMatching(interactionId);
        if (pending === null) return () => undefined;
        pending.activity_listeners.add(listener);
        return () => {
          pending.activity_listeners.delete(listener);
        };
      },
      subscribe_visibility: (listener) => {
        const pending = this.requireMatching(interactionId);
        if (pending === null) return () => undefined;
        pending.visibility_listeners.add(listener);
        return () => {
          pending.visibility_listeners.delete(listener);
        };
      },
      update: (updatedRequest) => {
        const pending = this.requireMatching(interactionId);
        if (pending === null || !this.options.is_run_active()) {
          throw new Error("The summary review is no longer pending.");
        }
        const updatedReview = cloneSummaryReviewRequest(
          updatedRequest,
          interactionId,
        );
        pending.request = updatedReview;
        this.options.on_updated(structuredClone(updatedReview));
      },
    };
  }

  resolve(
    interactionId: string,
    resolution: SummaryReviewResolution,
  ): void {
    const pending = this.requirePending(interactionId);
    validateResolution(pending.request, resolution);
    this.clear();
    pending.resolve(structuredClone(resolution));
  }

  touch(interactionId: string): boolean {
    const pending = this.requireMatching(interactionId);
    if (pending === null) return false;
    for (const listener of [...pending.activity_listeners]) {
      try {
        listener();
      } catch {
        // Plugin activity observers must not break core command handling.
      }
    }
    return true;
  }

  setVisibility(interactionId: string, isVisible: boolean): boolean {
    const pending = this.requireMatching(interactionId);
    if (pending === null) return false;
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

  reject(error: Error): void {
    const pending = this.pending;
    if (pending === null) return;
    this.clear();
    pending.reject(error);
  }

  private requireMatching(
    interactionId: string,
  ): PendingSummaryReview | null {
    return this.pending?.request.interaction_id === interactionId
      ? this.pending
      : null;
  }

  private requirePending(interactionId: string): PendingSummaryReview {
    const pending = this.requireMatching(interactionId);
    if (pending === null) {
      throw new Error("The summary review is no longer pending.");
    }
    return pending;
  }

  private clear(): void {
    const pending = this.pending;
    if (pending === null) return;
    if (pending.signal !== undefined && pending.on_abort !== undefined) {
      pending.signal.removeEventListener("abort", pending.on_abort);
    }
    pending.activity_listeners.clear();
    pending.visibility_listeners.clear();
    this.pending = null;
  }
}

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

function validateResolution(
  request: SummaryReviewRequest,
  resolution: SummaryReviewResolution,
): void {
  const allowedWhileLoading = request.loading_phase === "search"
    ? (
      resolution.decision === "change-provider" ||
      resolution.decision === "dismiss"
    )
    : request.loading_phase === "summary-grace" ||
        request.loading_phase === "summary"
    ? (
      resolution.decision === "change-provider" ||
      resolution.decision === "add-search" ||
      resolution.decision === "dismiss"
    )
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
  const searchProviderIds = new Set(
    request.search_providers.map((provider) => provider.provider_id),
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
    throw new Error("The summary review requires a search provider.");
  }
  if (
    resolution.selected_section_ids.some(
      (sectionId) =>
        !availableIds.has(sectionId) ||
        !selectableIds.has(sectionId),
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
    throw new Error("Query curation is unavailable during summary review.");
  }
}
