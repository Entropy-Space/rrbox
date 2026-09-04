import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [controlSource, viewerSource, styles, popoverSource] = await Promise.all([
  readFile(
    new URL("../src/ComposerModelControl.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/ComposerModelPopover.tsx", import.meta.url), "utf8"),
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

test("phone picker uses a top-layer modal without changing the desktop popover", () => {
  assert.match(viewerSource, /isMobileViewport=\{isMobileViewport\}/u);
  assert.match(controlSource, /<ComposerModelPopover\s+isMobile=\{isMobileViewport\}/u);
  assert.match(popoverSource, /if \(!isMobile\) \{[\s\S]*<div className=\{className\}/u);
  assert.match(popoverSource, /dialog\.showModal\(\)/u);
  assert.match(popoverSource, /aria-modal="true"/u);
  assert.match(popoverSource, /onCancel=/u);
  assert.match(popoverSource, /event\.target !== event\.currentTarget/u);
  assert.match(popoverSource, /event\.clientY > bounds\.bottom/u);
  assert.match(popoverSource, /if \(startedOnBackdropRef\.current\) onClose\(\)/u);
  assert.match(popoverSource, /onClick=\{onClose\}>\s*Done/u);
  assert.match(controlSource, /if \(!isOpen \|\| isMobileViewport\) return/u);
  assert.match(controlSource, /triggerRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
});

test("phone sheet spans the safe viewport and can shrink on short screens", () => {
  const sheetRule = styles.match(/\.composer-model-popover\.composer-model-sheet \{([^}]+)\}/u)?.[1];
  assert.ok(sheetRule);
  assert.match(sheetRule, /position: fixed/u);
  assert.match(sheetRule, /inset: auto env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\)/u);
  assert.match(sheetRule, /width: auto/u);
  assert.match(sheetRule, /max-width: none/u);
  assert.match(sheetRule, /max-height: calc\(100dvh - env\(safe-area-inset-top\) - env\(safe-area-inset-bottom\) - 12px\)/u);
  assert.match(styles, /\.composer-model-sheet \.composer-model-advanced-view \{[^}]*min-height: 0/u);
  assert.match(styles, /\.composer-model-sheet \[data-active-section="provider"\]/u);
  assert.match(styles, /\.composer-model-sheet \[data-active-section="model"\]/u);
  assert.match(styles, /\.composer-model-sheet \[data-active-section="effort"\]/u);
});
