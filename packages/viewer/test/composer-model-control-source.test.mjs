import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [controlSource, viewerSource, styles] = await Promise.all([
  readFile(
    new URL("../src/ComposerModelControl.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

test("composer exposes one model and reasoning entry point", () => {
  assert.match(viewerSource, /<ComposerModelControl/u);
  assert.doesNotMatch(viewerSource, /<ModelSelector|<ReasoningEffortSelector/u);
  assert.doesNotMatch(viewerSource, /Paperclip|SlidersHorizontal/u);
  assert.match(viewerSource, /aria-label="Add tools or attachments"/u);
});

test("model control provides quick and advanced selection surfaces", () => {
  assert.match(controlSource, /type MenuView = "quick" \| "advanced"/u);
  assert.match(controlSource, /type="range"/u);
  assert.match(controlSource, /data-section="provider"/u);
  assert.match(controlSource, /data-section="model"/u);
  assert.match(controlSource, /data-section="effort"/u);
  assert.match(controlSource, /Provider · Model · Effort/u);
});

test("advanced settings become drill-down navigation in narrow composers", () => {
  assert.match(styles, /@container \(max-width: 620px\)/u);
  assert.match(styles, /data-active-section="provider"/u);
  assert.match(styles, /data-active-section="model"/u);
  assert.match(styles, /data-active-section="effort"/u);
  assert.match(styles, /\.composer-model-mobile-step/u);
});
