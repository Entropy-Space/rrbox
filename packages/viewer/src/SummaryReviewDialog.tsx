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
import type { SummaryReviewResolution } from "@researchbox/protocol";
import { useEffect, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent.tsx";
import type { SummaryReviewView } from "./use-agent-session.ts";

export function SummaryReviewDialog({
  review,
  onResolve,
}: {
  review: SummaryReviewView | null;
  onResolve(resolution: SummaryReviewResolution): void;
}) {
  return review
    ? (
        <ActiveSummaryReviewDialog
          key={review.interaction_id}
          review={review}
          onResolve={onResolve}
        />
      )
    : <dialog className="summary-review-dialog" />;
}

function ActiveSummaryReviewDialog({
  review,
  onResolve,
}: {
  review: SummaryReviewView;
  onResolve(resolution: SummaryReviewResolution): void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [approvedText, setApprovedText] = useState(review.draft_text);
  const [feedbackText, setFeedbackText] = useState("");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [selectedSectionIds, setSelectedSectionIds] = useState<Set<string>>(
    () => new Set(review.selected_section_ids),
  );
  const isSelecting = review.stage === "select-evidence";
  const selectionChanged = !sameStringSet(
    selectedSectionIds,
    review.selected_section_ids,
  );

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
    !selectionChanged;
  const selectedIds = () => [...selectedSectionIds];

  function cancel() {
    if (review?.is_submitting) return;
    onResolve({
      decision: "cancel",
      approved_text: "",
      selected_section_ids: [],
      feedback_text: "",
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
                  }`}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={review.is_submitting}
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
          </section>

          {!isSelecting && (
            <section className="summary-review-editor">
              <span>
                <strong>
                  {isPreviewing ? "Summary preview" : "Approved summary"}
                </strong>
                <small>
                  {selectionChanged
                    ? "Selection changed. Regenerate before approval."
                    : "Only the approved Markdown is sent to the agent."}
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
