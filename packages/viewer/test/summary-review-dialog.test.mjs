import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [dialogSource, viewerSource, stylesSource] = await Promise.all([
  readFile(
    new URL("../src/SummaryReviewDialog.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("summary review is a modal approval boundary with editable output", () => {
  assert.match(dialogSource, /dialog\.showModal\(\)/u);
  assert.match(dialogSource, /aria-labelledby="summary-review-title"/u);
  assert.match(dialogSource, /type="checkbox"/u);
  assert.match(dialogSource, /<textarea/u);
  assert.match(dialogSource, /decision: "approve"/u);
  assert.match(dialogSource, /decision: "cancel"/u);
  assert.match(dialogSource, /decision: "raw"/u);
  assert.match(dialogSource, /decision: "summarize"/u);
  assert.match(dialogSource, /decision: "regenerate"/u);
  assert.match(dialogSource, /decision: "back"/u);
  assert.match(dialogSource, /<MarkdownContent/u);
  assert.match(dialogSource, /Summary regeneration feedback/u);
  assert.match(dialogSource, /Summary provider/u);
  assert.match(dialogSource, /Summary model/u);
  assert.match(dialogSource, /summary_model: selectedSummaryModel\(\)/u);
  assert.match(dialogSource, /formatDraftMetadata/u);
  assert.match(dialogSource, /summaryModelChanged/u);
  assert.match(dialogSource, /Regenerate before approval/u);
  assert.match(dialogSource, /selected_section_ids/u);
  assert.match(dialogSource, /rel="noreferrer"/u);
  assert.match(viewerSource, /<SummaryReviewDialog/u);
  assert.match(
    viewerSource,
    /inert=\{modalNavigationOpen \|\| summaryReview \? true : undefined\}/u,
  );
});

test("summary review bounds evidence and editor layout", () => {
  assert.match(stylesSource, /\.summary-review-dialog \{/u);
  assert.match(stylesSource, /max-height: min\(820px,/u);
  assert.match(stylesSource, /\.summary-review-evidence \{[\s\S]*overflow-y: auto;/u);
  assert.match(stylesSource, /\.summary-review-editor textarea \{/u);
  assert.match(stylesSource, /\.summary-review-preview \{/u);
  assert.match(stylesSource, /\.summary-review-models \{/u);
});
