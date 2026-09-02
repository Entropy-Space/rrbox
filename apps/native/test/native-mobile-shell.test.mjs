import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [indexSource, nativeStyles, viewerSource, viewerStyles] =
  await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../../../packages/viewer/src/ResearchBoxViewer.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../packages/viewer/src/styles.css",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

test("native viewport owns iOS safe areas without browser chrome directives", () => {
  assert.doesNotMatch(indexSource, /viewport-fit/u);
  assert.doesNotMatch(indexSource, /interactive-widget/u);
  assert.match(nativeStyles, /env\(safe-area-inset-top\)/u);
  assert.match(nativeStyles, /env\(safe-area-inset-bottom\)/u);
  assert.match(nativeStyles, /overscroll-behavior: none/u);
});

test("phone layout presents chat context and Workspace as a modal surface", () => {
  assert.match(viewerSource, /className="mobile-conversation-context"/u);
  assert.match(viewerSource, /isModal=\{isMobileViewport\}/u);
  assert.match(viewerSource, /role=\{isModal \? "dialog" : undefined\}/u);
  assert.match(viewerSource, /modalFocusTrapTarget/u);
  assert.match(viewerSource, /isMobileViewport \|\|\s+consumeImportFocusSuppression/u);
  assert.match(viewerStyles, /max-height: 500px/u);
  assert.match(viewerStyles, /\.workspace-panel\.workspace-open/u);
  assert.match(viewerStyles, /position: fixed/u);
  assert.match(viewerStyles, /\.composer-secondary-action/u);
  assert.match(viewerStyles, /font-size: 16px/u);
});

test("phone provider inputs prevent iOS focus zoom without disabling page zoom", () => {
  const phoneStyles = viewerStyles.slice(viewerStyles.indexOf("@media (max-width: 768px)"));
  assert.match(phoneStyles, /\.provider-field input,\s*\.provider-field select,\s*\.provider-field textarea\s*\{[^}]*font-size: 16px/u);
  assert.doesNotMatch(indexSource, /user-scalable=no|maximum-scale=1/u);
});
