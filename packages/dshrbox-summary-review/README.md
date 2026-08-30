# `@dshrbox/summary-review`

Native Cordis service for dshrbox's interactive summary-review workflow.

Summary review is live application state, not part of the canonical DSH
transcript. The service emits the existing ephemeral viewer `CoreEvent` values
for opening, updating, and cancelling a review while DSH session events remain
the source of truth for agent messages and tool execution.

This is intentionally separate from DSH's user-approval seam. Summary review
supports editable drafts, evidence selection, provider changes, additional
searches, visibility, activity, and deadlines; it is not a one-shot permission
decision.

The host activates the service for one application request at a time. Native
DSH plugins can then call `ctx.dshrboxSummaryReview.open()` and await the
returned resolution. The application command layer routes resolve, activity,
and visibility commands back to the service. Cancellation and Cordis disposal
reject any pending interaction and emit a dismiss event for the viewer.
