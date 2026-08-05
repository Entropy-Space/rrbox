import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  viewerSource,
  composerMenuSource,
  pluginsSource,
  sidebarSource,
  projectTreeSource,
  sharedStyles,
  webStyles,
  nativeStyles,
] = await Promise.all([
  readFile(
    new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/use-composer-command-menu.ts", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../src/PluginsPage.tsx", import.meta.url), "utf8"),
  readFile(
    new URL("../src/WorkspaceSidebar.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/sidebar-project-tree.ts", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(
    new URL("../../../apps/web/app/globals.css", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../../../apps/native/src/styles.css", import.meta.url),
    "utf8",
  ),
]);

test("form controls use one neutral keyboard focus treatment", () => {
  for (const styles of [sharedStyles, webStyles, nativeStyles]) {
    assert.doesNotMatch(styles, /#2f7ff7/iu);
  }
  assert.match(sharedStyles, /--focus-ring: #626262/u);
  assert.match(
    sharedStyles,
    /:where\(button, input, textarea, select\):focus-visible/u,
  );
  assert.match(
    sharedStyles,
    /\.chat-search-field:has\(input:focus-visible\)/u,
  );
  assert.match(
    sharedStyles,
    /\.composer:has\(textarea:focus-visible\)/u,
  );
});

test("draft persistence never becomes a global navigation lock", () => {
  const sidebarGuard = sourceBlock(
    viewerSource,
    "const isManagementDisabled =",
    "const isSidebarNavigationDisabled =",
  );
  const sidebarNavigationGuard = sourceBlock(
    viewerSource,
    "const isSidebarNavigationDisabled =",
    "const canSubmitDraft =",
  );
  assert.doesNotMatch(sidebarGuard, /isInputDraftPending/u);
  assert.doesNotMatch(
    sidebarNavigationGuard,
    /coreState\.is_running|coreState\.pending_prompt/u,
  );
  assert.match(sidebarSource, /isManagementDisabled/u);
  assert.doesNotMatch(sidebarSource, /inputDraft/u);
});

test("a submitted prompt has immediate local feedback", () => {
  assert.match(viewerSource, /withPendingPrompt\(coreState\.timeline/u);
  assert.match(viewerSource, /className="composer-submit-status"/u);
});

test("the active virtual chat row does not mount and unmount while typing", () => {
  assert.match(
    projectTreeSource,
    /return options\.activeSessionId === null;/u,
  );
  assert.doesNotMatch(projectTreeSource, /inputDraft/u);
});

test("plugin configuration stays editable while apply is unavailable", () => {
  assert.doesNotMatch(pluginsSource, /\sdisabled=/u);
  assert.match(pluginsSource, /aria-disabled=\{isSaveUnavailable\}/u);
  assert.match(pluginsSource, /if \(isSaveUnavailable\) return;/u);
  assert.match(
    pluginsSource,
    /You can keep editing\. \$\{saveBlockedReason\}/u,
  );
});

test("the composer separates drafting from sending", () => {
  const textarea = sourceBlock(
    viewerSource,
    "<textarea",
    "onChange=",
  );
  assert.match(textarea, /!coreState\.is_ready/u);
  assert.match(textarea, /coreState\.active_project_id === null/u);
  assert.doesNotMatch(
    textarea,
    /isManagementPending|isWorkspaceTransferPending/u,
  );
  assert.match(viewerSource, /const canSubmitDraft =/u);
  assert.match(
    viewerSource,
    /if \(!canSubmitDraft \|\| prompt\.trim\(\)\.length === 0\) return;/u,
  );
});

test("composer commands require keyboard acceptance and preserve literal sends", () => {
  assert.match(
    viewerSource,
    /composerCommandMenu\.prepareLiteralSubmit\(\);/u,
  );
  assert.match(
    viewerSource,
    /if \(commandResult !== "unhandled"\) return;/u,
  );
  assert.match(
    composerMenuSource,
    /\(event\.key !== "Enter" \|\| event\.shiftKey\)/u,
  );
  assert.match(
    composerMenuSource,
    /\(event\.key !== "Tab" \|\| event\.shiftKey\)/u,
  );
  assert.match(
    composerMenuSource,
    /dismissedDraft: draft,\s+acceptedCommandId: null,/u,
  );
});

test("the composer tracks the full IME lifecycle before handling Enter", () => {
  assert.match(viewerSource, /onCompositionStart=/u);
  assert.match(viewerSource, /onCompositionEnd=/u);
  assert.match(composerMenuSource, /event\.nativeEvent\.keyCode/u);
  assert.match(composerMenuSource, /event\.nativeEvent\.isComposing/u);
  assert.match(composerMenuSource, /return "ime";/u);
});

function sourceBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
