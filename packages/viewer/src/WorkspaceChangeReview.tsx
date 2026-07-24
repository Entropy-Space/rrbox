"use client";

import { FileDiff, LoaderCircle, RotateCcw } from "lucide-react";
import { useId, useMemo, type Ref } from "react";
import {
  createLineDiffModel,
  type LineDiffContentRow,
  type LineDiffModel,
  type LineDiffOmissionRow,
} from "./line-diff.ts";
import {
  createWorkspaceChangeReviewState,
  type WorkspaceChangeReviewData,
} from "./workspace-change-review.ts";

export type {
  WorkspaceChangeReviewData,
  WorkspaceChangeRevertStatus,
} from "./workspace-change-review.ts";

export type WorkspaceChangeReviewProps = {
  change: WorkspaceChangeReviewData;
  isReverting?: boolean;
  isRevertDisabled?: boolean;
  maxOutputRows?: number;
  revertButtonRef?: Ref<HTMLButtonElement>;
  onRequestRevert: () => void;
};

export function WorkspaceChangeReview({
  change,
  isReverting = false,
  isRevertDisabled = false,
  maxOutputRows,
  revertButtonRef,
  onRequestRevert,
}: WorkspaceChangeReviewProps) {
  const headingId = useId();
  const diffRegionId = useId();
  const diff = useMemo(
    () =>
      createLineDiffModel(
        change.before_content ?? "",
        change.after_content,
        maxOutputRows === undefined
          ? {}
          : { max_output_rows: maxOutputRows },
      ),
    [change.after_content, change.before_content, maxOutputRows],
  );
  const kindLabel =
    change.change_kind === "created" ? "Created file" : "Updated file";
  const reviewState = createWorkspaceChangeReviewState(change, {
    isReverting,
    isRevertDisabled,
  });

  return (
    <section
      className={`workspace-change-review ${change.revert_status}`}
      aria-labelledby={headingId}
      aria-busy={isReverting}
    >
      <header className="workspace-change-review-header">
        <span className="workspace-change-review-icon" aria-hidden="true">
          <FileDiff size={17} />
        </span>
        <div className="workspace-change-review-heading">
          <span className={`workspace-change-kind ${change.change_kind}`}>
            {kindLabel}
          </span>
          <h3 id={headingId}>
            <code title={change.path}>{change.path}</code>
          </h3>
        </div>
        <DiffStats diff={diff} />
        <button
          ref={revertButtonRef}
          className="workspace-change-revert"
          type="button"
          disabled={reviewState.isRevertDisabled}
          aria-describedby={
            reviewState.statusMessage ? diffRegionId : undefined
          }
          onClick={onRequestRevert}
        >
          {isReverting ? (
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
          ) : (
            <RotateCcw size={15} aria-hidden="true" />
          )}
          <span>{reviewState.revertButtonLabel}</span>
        </button>
      </header>

      {reviewState.statusMessage && (
        <div
          id={diffRegionId}
          className={`workspace-change-status ${change.revert_status}`}
          role={reviewState.statusRole ?? undefined}
        >
          {reviewState.statusMessage}
        </div>
      )}

      {(diff.is_simplified || diff.is_truncated) && (
        <p className="workspace-change-diff-note" role="note">
          {diff.is_simplified &&
            "This large change uses a simplified deterministic diff. "}
          {diff.is_truncated &&
            "Some rows are omitted to keep the preview responsive."}
        </p>
      )}

      {diff.additions === 0 && diff.deletions === 0 ? (
        <div className="workspace-change-empty">
          No textual difference remains in this change.
        </div>
      ) : (
        <div
          className="workspace-change-diff"
          role="region"
          aria-label={`Diff for ${change.path}`}
          tabIndex={0}
        >
          <table>
            <caption className="visually-hidden">
              {kindLabel} {change.path}. {diff.additions} additions and{" "}
              {diff.deletions} deletions.
            </caption>
            <tbody>
              {diff.rows.map((row, index) =>
                row.kind === "omission" ? (
                  <OmissionRow
                    key={`omission:${index}`}
                    row={row}
                  />
                ) : (
                  <ContentRow
                    key={`${row.kind}:${row.before_line_number ?? ""}:${row.after_line_number ?? ""}:${index}`}
                    row={row}
                  />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DiffStats({ diff }: { diff: LineDiffModel }) {
  return (
    <span
      className="workspace-change-stats"
      aria-label={`${pluralize(diff.additions, "addition")} and ${pluralize(diff.deletions, "deletion")}`}
    >
      <span className="workspace-change-additions" aria-hidden="true">
        +{diff.additions}
      </span>
      <span className="workspace-change-deletions" aria-hidden="true">
        −{diff.deletions}
      </span>
    </span>
  );
}

function ContentRow({ row }: { row: LineDiffContentRow }) {
  const label =
    row.kind === "addition"
      ? "Added line"
      : row.kind === "deletion"
        ? "Deleted line"
        : "Unchanged line";
  return (
    <tr className={`workspace-change-diff-row ${row.kind}`}>
      <td className="workspace-change-line-number" aria-hidden="true">
        {row.before_line_number}
      </td>
      <td className="workspace-change-line-number" aria-hidden="true">
        {row.after_line_number}
      </td>
      <td className="workspace-change-line-marker" aria-hidden="true">
        {row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : " "}
      </td>
      <td className="workspace-change-line-content">
        <span className="visually-hidden">{label}: </span>
        <code>{row.text}</code>
        {row.line_ending === null && (
          <span className="workspace-change-no-newline">
            No newline at end of file
          </span>
        )}
      </td>
    </tr>
  );
}

function OmissionRow({ row }: { row: LineDiffOmissionRow }) {
  return (
    <tr className="workspace-change-diff-row omission">
      <td colSpan={4}>{omissionCopy(row)}</td>
    </tr>
  );
}

function omissionCopy(row: LineDiffOmissionRow): string {
  if (row.addition_count > 0 || row.deletion_count > 0) {
    return `${pluralize(row.addition_count, "addition")} and ${pluralize(row.deletion_count, "deletion")} omitted.`;
  }
  return `${pluralize(
    Math.max(row.before_line_count, row.after_line_count),
    "unchanged line",
  )} omitted.`;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
