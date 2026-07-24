import assert from "node:assert/strict";
import test from "node:test";
import { defineWorkspaceBackendConformance } from "@researchbox/vfs-testkit";
import {
  MemoryWorkspace,
  MemoryWorkspaceBackend,
  VfsError,
} from "../src/index.ts";

defineWorkspaceBackendConformance({
  name: "Memory workspace backend",
  async create_backend({ seed_files }) {
    return {
      backend: new MemoryWorkspaceBackend(
        (initialFiles) =>
          new MemoryWorkspace(initialFiles ?? seed_files),
      ),
    };
  },
});

test("lists a deterministic file and directory view", async () => {
  const filesystem = new MemoryWorkspace({
    "/README.md": "hello",
    "/src/index.ts": "export {};",
  });

  assert.deepEqual((await filesystem.list("/")).entries, [
    { name: "src", path: "/src", kind: "directory", size: 0 },
    { name: "README.md", path: "/README.md", kind: "file", size: 5 },
  ]);
});

test("prevents file and directory collisions", () => {
  assert.throws(
    () =>
      new MemoryWorkspace({
        "/src": "file",
        "/src/index.ts": "nested",
      }),
    (error) => error instanceof VfsError && error.code === "not_directory",
  );
});

test("normalizes and validates seed paths before constructing a filesystem", () => {
  assert.throws(
    () =>
      new MemoryWorkspace({
        "/src/index.ts": "nested",
        "/src": "file",
      }),
    (error) => error instanceof VfsError && error.code === "is_directory",
  );
  assert.throws(
    () =>
      new MemoryWorkspace({
        "notes.txt": "first",
        "/notes.txt": "duplicate",
      }),
    (error) => error instanceof VfsError && error.code === "conflict",
  );
});

test("confines paths to the virtual workspace", async () => {
  const filesystem = new MemoryWorkspace();

  await assert.rejects(
    filesystem.write("../../outside.txt", "nope"),
    (error) => error instanceof VfsError && error.code === "invalid_path",
  );
});

test("reads and overwrites text files", async () => {
  const filesystem = new MemoryWorkspace();
  await filesystem.write("/notes/today.md", "first");
  await filesystem.write("/notes/today.md", "second");

  assert.equal(
    (await filesystem.read("/notes/today.md")).content,
    "second",
  );
});

test("returns atomic write results and records compact workspace changes", async () => {
  const filesystem = new MemoryWorkspace();
  const createdWrite = await filesystem.write(
    "/notes/today.md",
    "alpha\nbeta\n",
    { change: changeMetadata("change-1", "write_file") },
  );
  const created = createdWrite.result;
  assert.equal(createdWrite.workspace_revision, 1);
  assert.deepEqual(created, {
    path: "/notes/today.md",
    change_kind: "created",
    before_content: null,
    after_content: "alpha\nbeta\n",
    change: {
      ...changeMetadata("change-1", "write_file"),
      path: "/notes/today.md",
      change_kind: "created",
      before_content: null,
      after_content: "alpha\nbeta\n",
      additions: 2,
      deletions: 0,
      byte_size: 11,
    },
  });
  created.change.path = "/tampered.txt";
  assert.equal(
    (await filesystem.listChanges()).changes[0].path,
    "/notes/today.md",
  );

  const updatedWrite = await filesystem.write(
    "/notes/today.md",
    "alpha\ngamma\n",
    { change: changeMetadata("change-2", "replace_text") },
  );
  const updated = updatedWrite.result;
  assert.equal(updatedWrite.workspace_revision, 2);
  assert.equal(updated.change_kind, "updated");
  assert.deepEqual(
    {
      additions: updated.change.additions,
      deletions: updated.change.deletions,
      byte_size: updated.change.byte_size,
    },
    { additions: 1, deletions: 1, byte_size: 12 },
  );

  const unchangedWrite = await filesystem.write(
    "/notes/today.md",
    "alpha\ngamma\n",
    { change: changeMetadata("change-3", "write_file") },
  );
  const unchanged = unchangedWrite.result;
  assert.equal(unchangedWrite.workspace_revision, 2);
  assert.equal(unchanged.change_kind, "unchanged");
  assert.equal(unchanged.change, null);
  assert.deepEqual(
    (await filesystem.listChanges()).changes.map(
      (change) => change.change_id,
    ),
    ["change-1", "change-2"],
  );
});

test("compare-and-swap writes reject stale content without mutation", async () => {
  const filesystem = new MemoryWorkspace({ "/notes.txt": "original" });

  await assert.rejects(
    filesystem.write("/notes.txt", "stale update", {
      expected_content: "different",
    }),
    (error) => error instanceof VfsError && error.code === "conflict",
  );
  assert.equal((await filesystem.read("/notes.txt")).content, "original");

  await filesystem.write("/notes.txt", "updated", {
    expected_content: "original",
  });
  await filesystem.write("/created.txt", "created", {
    expected_content: null,
  });
  await assert.rejects(
    filesystem.write("/created.txt", "replaced", { expected_content: null }),
    (error) => error instanceof VfsError && error.code === "conflict",
  );
});

test("only one concurrent compare-and-swap write can commit", async () => {
  const filesystem = new MemoryWorkspace({ "/notes.txt": "original" });
  const results = await Promise.allSettled([
    filesystem.write("/notes.txt", "first", {
      expected_content: "original",
    }),
    filesystem.write("/notes.txt", "second", {
      expected_content: "original",
    }),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.ok(
    ["first", "second"].includes(
      (await filesystem.read("/notes.txt")).content,
    ),
  );
});

test("duplicate workspace change ids roll back the file mutation", async () => {
  const filesystem = new MemoryWorkspace();
  const change = changeMetadata("same-change", "write_file");
  await filesystem.write("/first.txt", "first", { change });

  await assert.rejects(
    filesystem.write("/second.txt", "second", { change }),
    (error) => error instanceof VfsError && error.code === "conflict",
  );
  await assert.rejects(
    filesystem.read("/second.txt"),
    (error) => error instanceof VfsError && error.code === "not_found",
  );
  assert.equal((await filesystem.listChanges()).changes.length, 1);
});

test("guarded removal cannot delete a changed file or a directory", async () => {
  const filesystem = new MemoryWorkspace({
    "/notes/today.md": "current",
  });

  await assert.rejects(
    filesystem.remove("/notes/today.md", { expected_content: "stale" }),
    (error) => error instanceof VfsError && error.code === "conflict",
  );
  assert.equal(
    (await filesystem.read("/notes/today.md")).content,
    "current",
  );
  await assert.rejects(
    filesystem.remove("/notes"),
    (error) => error instanceof VfsError && error.code === "is_directory",
  );
  await filesystem.remove("/notes/today.md", { expected_content: "current" });
  await assert.rejects(
    filesystem.read("/notes/today.md"),
    (error) => error instanceof VfsError && error.code === "not_found",
  );
});

function changeMetadata(changeId, toolName) {
  return {
    change_id: changeId,
    session_id: "session-1",
    tool_call_block_id: "tool-call-block-1",
    assistant_message_index: 1,
    tool_call_id: `tool-${changeId}`,
    tool_name: toolName,
    created_at: `2026-07-23T00:00:0${changeId.at(-1) ?? "0"}.000Z`,
  };
}
