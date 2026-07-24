import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { revertedWorkspaceChangeSnapshot } from "../src/use-workspace-change-review.ts";

test("a created change fallback snapshot records removal after revert", () => {
  const reverted = revertedWorkspaceChangeSnapshot(
    snapshot({
      change_kind: "created",
      before_content: null,
    }),
    {
      workspace_revision: 12,
      reverted_at_workspace_revision: 12,
    },
  );

  assert.equal(reverted.workspace_revision, 12);
  assert.equal(reverted.change.current_content, null);
  assert.equal(reverted.change.reverted_at_workspace_revision, 12);
  assert.equal(reverted.change.revert_status, "already_reverted");
});

test("an updated change fallback snapshot preserves an empty original", () => {
  const reverted = revertedWorkspaceChangeSnapshot(
    snapshot({
      change_kind: "updated",
      before_content: "",
    }),
    {
      workspace_revision: 12,
      reverted_at_workspace_revision: 12,
    },
  );

  assert.equal(reverted.change.current_content, "");
  assert.equal(reverted.change.revert_status, "already_reverted");
});

test("the viewer requires an explicit second revert action", async () => {
  const viewer = await readFile(
    new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
    "utf8",
  );

  assert.match(viewer, />Revert this agent change\?</);
  assert.match(viewer, /"Revert now"/);
  assert.match(viewer, /Later edits will never be overwritten\./);
  assert.match(viewer, /aria-label="Confirm workspace change revert"/);
  assert.match(viewer, /aria-controls="researchbox-workspace"/);
  assert.match(viewer, /inert=\{isOpen \? undefined : true\}/);
});

function snapshot(overrides) {
  return {
    project_id: "project-1",
    workspace_revision: 11,
    change: {
      change_id: "change-1",
      tool_call_id: "call-1",
      path: "/notes.md",
      change_kind: "updated",
      additions: 1,
      deletions: 1,
      byte_size: 6,
      before_content: "before",
      after_content: "after",
      current_content: "after",
      reverted_at_workspace_revision: null,
      revert_status: "available",
      ...overrides,
    },
  };
}
