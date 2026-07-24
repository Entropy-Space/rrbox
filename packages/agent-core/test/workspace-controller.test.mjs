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
    async write() {
      throw new Error("Unexpected write");
    },
    async remove() {
      throw new Error("Unexpected remove");
    },
    async listChanges() {
      throw new Error("Unexpected listChanges");
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
});
