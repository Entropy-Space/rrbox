import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createWorkspaceChangeReviewState } from "../src/workspace-change-review.ts";

test("available changes expose an enabled revert action", () => {
  const state = createWorkspaceChangeReviewState(change());

  assert.deepEqual(state, {
    statusMessage: null,
    statusRole: null,
    revertButtonLabel: "Revert change",
    isRevertDisabled: false,
  });
});

test("pending and externally disabled changes cannot be reverted twice", () => {
  assert.deepEqual(
    createWorkspaceChangeReviewState(change(), { isReverting: true }),
    {
      statusMessage: null,
      statusRole: null,
      revertButtonLabel: "Reverting…",
      isRevertDisabled: true,
    },
  );
  assert.equal(
    createWorkspaceChangeReviewState(change(), {
      isRevertDisabled: true,
    }).isRevertDisabled,
    true,
  );
});

test("conflicts explain whether the current file changed or disappeared", () => {
  const changed = createWorkspaceChangeReviewState(
    change({
      current_content: "newer content\n",
      revert_status: "conflict",
    }),
  );
  const missing = createWorkspaceChangeReviewState(
    change({
      current_content: null,
      revert_status: "conflict",
    }),
  );

  assert.equal(changed.statusRole, "alert");
  assert.match(changed.statusMessage, /changed after this agent edit/i);
  assert.equal(changed.revertButtonLabel, "Revert unavailable");
  assert.equal(changed.isRevertDisabled, true);
  assert.equal(missing.statusRole, "alert");
  assert.match(missing.statusMessage, /no longer exists/i);
  assert.equal(missing.isRevertDisabled, true);
});

test("an already-reverted change reports a stable terminal state", () => {
  const state = createWorkspaceChangeReviewState(
    change({
      current_content: "before\n",
      revert_status: "already_reverted",
    }),
  );

  assert.equal(state.statusRole, "status");
  assert.match(state.statusMessage, /already been reverted/i);
  assert.equal(state.revertButtonLabel, "Reverted");
  assert.equal(state.isRevertDisabled, true);
});

test("the review component exposes a bounded accessible diff surface", async () => {
  const [component, styles, entrypoint] = await Promise.all([
    readFile(
      new URL("../src/WorkspaceChangeReview.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../apps/web/app/globals.css", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(component, /aria-busy=\{isReverting\}/);
  assert.match(component, /role="region"/);
  assert.match(component, /tabIndex=\{0\}/);
  assert.match(component, /<table>/);
  assert.match(component, /<caption className="visually-hidden">/);
  assert.match(component, /className="visually-hidden">\{label\}/);
  assert.match(component, /No newline at end of file/);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/);
  assert.match(styles, /\.workspace-change-diff\s*\{[^}]*max-height:/s);
  assert.match(styles, /\.workspace-change-diff\s*\{[^}]*overflow: auto;/s);
  assert.match(styles, /\.workspace-change-diff-row\.addition/);
  assert.match(styles, /\.workspace-change-diff-row\.deletion/);
  assert.match(entrypoint, /export \* from "\.\/WorkspaceChangeReview\.tsx"/);
  assert.match(entrypoint, /export \* from "\.\/line-diff\.ts"/);
});

function change(overrides = {}) {
  return {
    path: "/notes.md",
    change_kind: "updated",
    before_content: "before\n",
    after_content: "after\n",
    current_content: "after\n",
    revert_status: "available",
    ...overrides,
  };
}
