"use client";

import {
  ArrowLeft,
  Check,
  Eye,
  RefreshCw,
  Search,
  Send,
  X,
} from "lucide-react";
import type {
  ModelSelection,
  ProviderSummary,
  SummaryReviewResolution,
} from "@researchbox/protocol";
import { useEffect, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent.tsx";
import type { SummaryReviewView } from "./use-agent-session.ts";

export function SummaryReviewDialog({
  review,
  providers,
  active_model,
  onResolve,
}: {
  review: SummaryReviewView | null;
  providers: ProviderSummary[];
  active_model: ModelSelection;
  onResolve(resolution: SummaryReviewResolution): void;
}) {
  return review
    ? (
        <ActiveSummaryReviewDialog
          key={review.interaction_id}
          review={review}
          providers={providers}
          active_model={active_model}
          onResolve={onResolve}
        />
      )
    : <dialog className="summary-review-dialog" />;
}

function ActiveSummaryReviewDialog({
  review,
  providers,
  active_model,
  onResolve,
}: {
  review: SummaryReviewView;
  providers: ProviderSummary[];
  active_model: ModelSelection;
  onResolve(resolution: SummaryReviewResolution): void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [approvedText, setApprovedText] = useState(review.draft_text);
  const [feedbackText, setFeedbackText] = useState("");
  const [queryText, setQueryText] = useState(review.query_draft);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [summaryProviderId, setSummaryProviderId] = useState(
    review.summary_model?.provider_id ?? "",
  );
  const [summaryModelId, setSummaryModelId] = useState(
    review.summary_model?.model_id ?? "",
  );
  const [selectedSectionIds, setSelectedSectionIds] = useState<Set<string>>(
    () => new Set(review.selected_section_ids),
  );
  const isSelecting = review.stage === "select-evidence";
  const selectionChanged = !sameStringSet(
    selectedSectionIds,
    review.selected_section_ids,
  );
  const summaryModelChanged =
    summaryProviderId !== (review.summary_model?.provider_id ?? "") ||
    summaryModelId !== (review.summary_model?.model_id ?? "");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    if (!isSelecting) {
      window.requestAnimationFrame(() => editorRef.current?.focus());
    }
  }, [isSelecting]);

  const canApprove =
    !review.is_submitting &&
    approvedText.trim().length > 0 &&
    selectedSectionIds.size > 0 &&
    !selectionChanged &&
    !summaryModelChanged;
  const selectedIds = () => [...selectedSectionIds];
  const readyProviders = providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter(
        (model) => model.availability === "ready",
      ),
    }))
    .filter(
      (provider) =>
        provider.availability === "ready" && provider.models.length > 0,
    );
  const selectedProvider = readyProviders.find(
    (provider) => provider.provider_id === summaryProviderId,
  );
  const selectedSummaryModel = (): ModelSelection | null =>
    summaryProviderId && summaryModelId
      ? {
          provider_id: summaryProviderId,
          model_id: summaryModelId,
        }
      : null;
  const activeModelLabel =
    providers
      .find(
        (provider) =>
          provider.provider_id === active_model.provider_id,
      )
      ?.models.find(
        (model) => model.model_id === active_model.model_id,
      )?.display_name ?? active_model.model_id;

  function cancel() {
    if (review?.is_submitting) return;
    onResolve({
      decision: "cancel",
      approved_text: "",
      selected_section_ids: [],
      feedback_text: "",
      summary_model: selectedSummaryModel(),
      query_text: "",
    });
  }

  return (
    <dialog
      ref={dialogRef}
      className="summary-review-dialog"
      aria-labelledby="summary-review-title"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <section className="summary-review-panel">
        <header className="summary-review-header">
          <span className="summary-review-icon" aria-hidden={true}>
            <Search size={20} />
          </span>
          <div>
            <h2 id="summary-review-title">{review.title}</h2>
            <p>
              {isSelecting
                ? "Choose which search results the agent may use."
                : "Edit, preview, or regenerate the synthesis before approval."}
            </p>
            <div className="summary-review-models">
              <label>
                <span>Summary provider</span>
                <select
                  value={summaryProviderId}
                  disabled={review.is_submitting}
                  onChange={(event) => {
                    const providerId = event.target.value;
                    const provider = readyProviders.find(
                      (candidate) =>
                        candidate.provider_id === providerId,
                    );
                    setSummaryProviderId(providerId);
                    setSummaryModelId(
                      provider?.models[0]?.model_id ?? "",
                    );
                  }}
                >
                  <option value="">Auto ({activeModelLabel})</option>
                  {readyProviders.map((provider) => (
                    <option
                      key={provider.provider_id}
                      value={provider.provider_id}
                    >
                      {provider.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Summary model</span>
                <select
                  value={summaryModelId}
                  disabled={
                    review.is_submitting || summaryProviderId === ""
                  }
                  onChange={(event) =>
                    setSummaryModelId(event.target.value)}
                >
                  {summaryProviderId === ""
                    ? <option value="">Active model</option>
                    : selectedProvider?.models.map((model) => (
                        <option
                          key={model.model_id}
                          value={model.model_id}
                        >
                          {model.display_name}
                        </option>
                      ))}
                </select>
              </label>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Cancel summary review"
            disabled={review.is_submitting}
            onClick={cancel}
          >
            <X size={18} />
          </button>
        </header>

        <div className="summary-review-content">
          <section
            className="summary-review-evidence"
            aria-labelledby="summary-review-evidence-title"
          >
            <h3 id="summary-review-evidence-title">Search evidence</h3>
            {review.sections.map((section) => {
              const selected = selectedSectionIds.has(section.section_id);
              return (
                <article
                  key={section.section_id}
                  className={`summary-review-section ${
                    selected ? "selected" : ""
                  } ${section.is_selectable ? "" : "unavailable"}`}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={
                        review.is_submitting || !section.is_selectable
                      }
                      onChange={(event) => {
                        setSelectedSectionIds((current) => {
                          const next = new Set(current);
                          if (event.target.checked) {
                            next.add(section.section_id);
                          } else {
                            next.delete(section.section_id);
                          }
                          return next;
                        });
                      }}
                    />
                    <strong>{section.title}</strong>
                  </label>
                  <p>{section.body}</p>
                  {section.sources.length > 0 && (
                    <ul>
                      {section.sources.map((source) => (
                        <li key={source.url}>
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {source.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
            {isSelecting && (
              <div className="summary-review-query-curation">
                <label htmlFor="summary-review-add-query">
                  Add another search
                </label>
                <input
                  id="summary-review-add-query"
                  type="text"
                  value={queryText}
                  maxLength={4 * 1024}
                  disabled={review.is_submitting}
                  placeholder="Enter another research angle"
                  onChange={(event) => setQueryText(event.target.value)}
                />
                {review.query_notice && (
                  <small role="status">{review.query_notice}</small>
                )}
                <div>
                  <button
                    type="button"
                    disabled={
                      review.is_submitting || queryText.trim().length === 0
                    }
                    onClick={() => {
                      onResolve({
                        decision: "rewrite-query",
                        approved_text: "",
                        selected_section_ids: selectedIds(),
                        feedback_text: "",
                        summary_model: selectedSummaryModel(),
                        query_text: queryText.trim(),
                      });
                    }}
                  >
                    <RefreshCw size={15} />
                    Improve query
                  </button>
                  <button
                    className="primary"
                    type="button"
                    disabled={
                      review.is_submitting || queryText.trim().length === 0
                    }
                    onClick={() => {
                      onResolve({
                        decision: "add-search",
                        approved_text: "",
                        selected_section_ids: selectedIds(),
                        feedback_text: "",
                        summary_model: selectedSummaryModel(),
                        query_text: queryText.trim(),
                      });
                    }}
                  >
                    <Search size={15} />
                    Add search
                  </button>
                </div>
              </div>
            )}
          </section>

          {!isSelecting && (
            <section className="summary-review-editor">
              <span>
                <strong>
                  {isPreviewing ? "Summary preview" : "Approved summary"}
                </strong>
                <small>
                  {selectionChanged || summaryModelChanged
                    ? `${
                        selectionChanged ? "Selection" : "Summary model"
                      } changed. Regenerate before approval.`
                    : formatDraftMetadata(review)}
                </small>
              </span>
              {isPreviewing
                ? (
                    <div className="summary-review-preview">
                      <MarkdownContent
                        source={approvedText}
                        isStreaming={false}
                      />
                    </div>
                  )
                : (
                    <textarea
                      ref={editorRef}
                      value={approvedText}
                      disabled={review.is_submitting}
                      onChange={(event) =>
                        setApprovedText(event.target.value)}
                    />
                  )}
              <input
                type="text"
                value={feedbackText}
                disabled={review.is_submitting}
                placeholder="Optional feedback for regeneration"
                aria-label="Summary regeneration feedback"
                onChange={(event) => setFeedbackText(event.target.value)}
              />
            </section>
          )}
        </div>

        <footer className="summary-review-footer">
          <span
            className={review.error_message ? "error" : ""}
            role={review.error_message ? "alert" : "status"}
          >
            {review.error_message ??
              `${selectedSectionIds.size} of ${review.sections.length} evidence sections selected`}
          </span>
          <div>
            <button
              type="button"
              disabled={review.is_submitting}
              onClick={cancel}
            >
              Cancel search
            </button>
            {isSelecting
              ? (
                  <>
                    <button
                      type="button"
                      disabled={
                        review.is_submitting ||
                        selectedSectionIds.size === 0
                      }
                      onClick={() => {
                        onResolve({
                          decision: "raw",
                          approved_text: "",
                          selected_section_ids: selectedIds(),
                          feedback_text: "",
                          summary_model: selectedSummaryModel(),
                          query_text: "",
                        });
                      }}
                    >
                      <Send size={16} />
                      Send raw
                    </button>
                    <button
                      className="primary"
                      type="button"
                      disabled={
                        review.is_submitting ||
                        selectedSectionIds.size === 0
                      }
                      onClick={() => {
                        onResolve({
                          decision: "summarize",
                          approved_text: "",
                          selected_section_ids: selectedIds(),
                          feedback_text: "",
                          summary_model: selectedSummaryModel(),
                          query_text: "",
                        });
                      }}
                    >
                      <Check size={16} />
                      Summarize selected
                    </button>
                  </>
                )
              : (
                  <>
                    <button
                      type="button"
                      disabled={review.is_submitting}
                      onClick={() => {
                        onResolve({
                          decision: "back",
                          approved_text: "",
                          selected_section_ids: selectedIds(),
                          feedback_text: "",
                          summary_model: selectedSummaryModel(),
                          query_text: "",
                        });
                      }}
                    >
                      <ArrowLeft size={16} />
                      Back
                    </button>
                    <button
                      type="button"
                      disabled={
                        review.is_submitting ||
                        selectedSectionIds.size === 0
                      }
                      onClick={() => {
                        onResolve({
                          decision: "regenerate",
                          approved_text: approvedText,
                          selected_section_ids: selectedIds(),
                          feedback_text: feedbackText.trim(),
                          summary_model: selectedSummaryModel(),
                          query_text: "",
                        });
                      }}
                    >
                      <RefreshCw size={16} />
                      Regenerate
                    </button>
                    <button
                      type="button"
                      disabled={review.is_submitting}
                      onClick={() => setIsPreviewing((current) => !current)}
                    >
                      <Eye size={16} />
                      {isPreviewing ? "Edit" : "Preview"}
                    </button>
                    <button
                      className="primary"
                      type="button"
                      disabled={!canApprove}
                      onClick={() => {
                        onResolve({
                          decision: "approve",
                          approved_text: approvedText.trim(),
                          selected_section_ids: selectedIds(),
                          feedback_text: "",
                          summary_model: selectedSummaryModel(),
                          query_text: "",
                        });
                      }}
                    >
                      {review.is_submitting
                        ? "Approving…"
                        : (
                            <>
                              <Check size={16} />
                              Approve summary
                            </>
                          )}
                    </button>
                  </>
                )}
          </div>
        </footer>
      </section>
    </dialog>
  );
}

function sameStringSet(
  current: Set<string>,
  expected: string[],
): boolean {
  return current.size === expected.length &&
    expected.every((value) => current.has(value));
}

function formatDraftMetadata(review: SummaryReviewView): string {
  const metadata = review.draft_metadata;
  if (!metadata) return "Only the approved Markdown is sent to the agent.";
  const model = metadata.model
    ? `${metadata.model.provider_id}/${metadata.model.model_id}`
    : "deterministic fallback";
  const requestedModel = review.summary_model
    ? `${review.summary_model.provider_id}/${review.summary_model.model_id}`
    : null;
  const modelLabel =
    requestedModel && requestedModel !== model
      ? `requested ${requestedModel}; generated with ${model}`
      : model;
  const timing = `${(metadata.duration_ms / 1_000).toFixed(1)}s`;
  const tokens = `~${metadata.token_estimate} tokens`;
  const fallback = metadata.fallback_reason
    ? ` · ${metadata.fallback_reason}`
    : "";
  return `${modelLabel} · ${timing} · ${tokens}${fallback}`;
}
