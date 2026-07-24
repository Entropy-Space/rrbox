import assert from "node:assert/strict";
import test from "node:test";
import { capturePortableWorkspace } from "@researchbox/workspace-archive/snapshot";
import { WorkspaceController } from "../src/index.ts";

test("WorkspaceController preserves the optional bulk snapshot capability", async () => {
  const filesystem = {
    async list() {
      throw new Error("Bulk capture must not fall back to list.");
    },
    async read() {
      throw new Error("Bulk capture must not fall back to read.");
    },
    async getPathState(path) {
      assert.equal(path, "/missing.txt");
      return {
        workspace_revision: 4,
        path,
        kind: "missing",
        path_revision: null,
      };
    },
    async write() {
      throw new Error("Unexpected write");
    },
    async remove() {
      throw new Error("Unexpected remove");
    },
    async listChanges() {
      throw new Error("Unexpected listChanges");
    },
    async getChange(changeId) {
      assert.equal(changeId, "missing-change");
      return {
        workspace_revision: 4,
        change: null,
      };
    },
    async revertChange(changeId) {
      assert.equal(changeId, "tracked-change");
      return {
        workspace_revision: 5,
        revert_outcome: "applied",
        reverted_at_workspace_revision: 5,
        change: {
          change_id: "tracked-change",
          session_id: "session",
          tool_call_block_id: "block",
          assistant_message_index: 0,
          tool_call_id: "tool",
          tool_name: "write_file",
          created_at: "2026-07-24T00:00:00.000Z",
          applied_workspace_revision: 4,
          reverted_at_workspace_revision: 5,
          path: "/tracked.txt",
          change_kind: "created",
          before_content: null,
          after_content: "tracked",
          additions: 1,
          deletions: 0,
          byte_size: 7,
        },
      };
    },
    async readFilesSnapshot() {
      return {
        workspace_revision: 4,
        files: [{ path: "/captured.txt", content: "bulk" }],
      };
    },
  };
  const controller = new WorkspaceController(filesystem);

  assert.deepEqual(await capturePortableWorkspace(controller), {
    snapshot: {
      files: [{ path: "/captured.txt", content: "bulk" }],
    },
    workspace_revision: 4,
  });
  assert.deepEqual(await controller.getChange("missing-change"), {
    workspace_revision: 4,
    change: null,
  });
  assert.deepEqual(await controller.getPathState("/missing.txt"), {
    workspace_revision: 4,
    path: "/missing.txt",
    kind: "missing",
    path_revision: null,
  });
  assert.deepEqual(
    await controller.revertChange("tracked-change"),
    {
      workspace_revision: 5,
      revert_outcome: "applied",
      reverted_at_workspace_revision: 5,
      change: {
        change_id: "tracked-change",
        session_id: "session",
        tool_call_block_id: "block",
        assistant_message_index: 0,
        tool_call_id: "tool",
        tool_name: "write_file",
        created_at: "2026-07-24T00:00:00.000Z",
        applied_workspace_revision: 4,
        reverted_at_workspace_revision: 5,
        path: "/tracked.txt",
        change_kind: "created",
        before_content: null,
        after_content: "tracked",
        additions: 1,
        deletions: 0,
        byte_size: 7,
      },
    },
  );
});
