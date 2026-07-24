import assert from "node:assert/strict";
import test from "node:test";

export function defineWorkspaceBackendConformance({
  name,
  create_backend,
}) {
  test(`${name}: workspace lifecycle and project isolation`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/README.md": "seed",
    });
    const first = await backend.create("project-a");

    assert.equal(await first.read("/README.md"), "seed");
    await first.write("/only-a.txt", "project a", {
      change: changeMetadata(
        "project-a-change",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    assert.equal(
      await (await backend.open("project-a")).read("/only-a.txt"),
      "project a",
    );
    await assert.rejects(
      backend.create("project-a"),
      hasBackendCode("already_exists"),
    );

    const second = await backend.create("project-b");
    assert.equal(await second.read("/README.md"), "seed");
    await second.write("/only-b.txt", "project b", {
      change: changeMetadata(
        "project-b-change",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    await assert.rejects(
      second.read("/only-a.txt"),
      hasVfsCode("not_found"),
    );
    assert.deepEqual(
      (await first.listChanges()).map((change) => change.change_id),
      ["project-a-change"],
    );
    assert.deepEqual(
      (await second.listChanges()).map((change) => change.change_id),
      ["project-b-change"],
    );
    await assert.rejects(
      backend.open("missing-project"),
      hasBackendCode("not_found"),
    );

    await backend.delete("project-a");
    await backend.delete("project-a");
    await assert.rejects(
      backend.open("project-a"),
      hasBackendCode("not_found"),
    );
    const recreated = await backend.create("project-a");
    assert.deepEqual(await recreated.listChanges(), []);
    assert.equal(await recreated.read("/README.md"), "seed");
    assert.deepEqual(
      (await second.listChanges()).map((change) => change.change_id),
      ["project-b-change"],
    );
  });

  test(`${name}: paths, ordering, and UTF-8 sizes are portable`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/zeta.txt": "z",
      "/Alpha.txt": "A",
      "/Case.txt": "upper",
      "/case.txt": "lower",
      "/e\u0301.txt": "decomposed",
      "/é.txt": "é",
      "/🐱.txt": "🐱",
      "/folder/子.txt": "child",
    });
    const workspace = await backend.create("project");

    assert.deepEqual(await workspace.list("/"), [
      { name: "folder", path: "/folder", kind: "directory", size: 0 },
      { name: "Alpha.txt", path: "/Alpha.txt", kind: "file", size: 1 },
      { name: "Case.txt", path: "/Case.txt", kind: "file", size: 5 },
      { name: "case.txt", path: "/case.txt", kind: "file", size: 5 },
      { name: "e\u0301.txt", path: "/e\u0301.txt", kind: "file", size: 10 },
      { name: "zeta.txt", path: "/zeta.txt", kind: "file", size: 1 },
      { name: "é.txt", path: "/é.txt", kind: "file", size: 2 },
      { name: "🐱.txt", path: "/🐱.txt", kind: "file", size: 4 },
    ]);
    assert.equal(await workspace.read("/Case.txt"), "upper");
    assert.equal(await workspace.read("/case.txt"), "lower");
    assert.equal(await workspace.read("/e\u0301.txt"), "decomposed");
    assert.equal(await workspace.read("/é.txt"), "é");

    await workspace.write("notes\\drafts\\..\\today.md", "today");
    assert.equal(await workspace.read("/notes/today.md"), "today");
    assert.deepEqual(await workspace.list("/absent"), []);
    await assert.rejects(
      workspace.list("/Alpha.txt"),
      hasVfsCode("not_directory"),
    );
    await assert.rejects(
      workspace.read("/folder"),
      hasVfsCode("is_directory"),
    );
    await assert.rejects(
      workspace.read("/"),
      hasVfsCode("invalid_path"),
    );
    await assert.rejects(
      workspace.write("../../outside.txt", "outside"),
      hasVfsCode("invalid_path"),
    );
    await assert.rejects(
      workspace.write("/bad\0path", "invalid"),
      hasVfsCode("invalid_path"),
    );
  });

  test(`${name}: implicit directory collisions are rejected`, async (context) => {
    const { backend } = await createHarness(context, create_backend);
    const workspace = await backend.create("project");

    await workspace.write("/file", "root");
    await assert.rejects(
      workspace.write("/file/nested.txt", "nested"),
      hasVfsCode("not_directory"),
    );
    await workspace.write("/directory/nested.txt", "nested");
    await assert.rejects(
      workspace.write("/directory", "replacement"),
      hasVfsCode("is_directory"),
    );
  });

  test(`${name}: writes and compare-and-swap are exact`, async (context) => {
    const { backend } = await createHarness(context, create_backend);
    const workspace = await backend.create("project");

    const created = await workspace.write("/notes.txt", "original", {
      expected_content: null,
    });
    assert.deepEqual(
      {
        path: created.path,
        change_kind: created.change_kind,
        before_content: created.before_content,
        after_content: created.after_content,
      },
      {
        path: "/notes.txt",
        change_kind: "created",
        before_content: null,
        after_content: "original",
      },
    );
    const unchanged = await workspace.write("/notes.txt", "original");
    assert.equal(unchanged.change_kind, "unchanged");
    assert.equal(unchanged.change, null);

    const contenders = await Promise.allSettled([
      workspace.write("/notes.txt", "first", {
        expected_content: "original",
      }),
      workspace.write("/notes.txt", "second", {
        expected_content: "original",
      }),
    ]);
    assert.equal(
      contenders.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      contenders.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.ok(["first", "second"].includes(await workspace.read("/notes.txt")));
    await assert.rejects(
      workspace.write("/notes.txt", "stale", {
        expected_content: "original",
      }),
      hasVfsCode("conflict"),
    );
  });

  test(`${name}: file writes and change receipts commit atomically`, async (context) => {
    const { backend } = await createHarness(context, create_backend);
    const workspace = await backend.create("project");
    const later = changeMetadata(
      "change-z",
      "2026-07-24T00:00:00.000Z",
    );
    const earlier = changeMetadata(
      "change-a",
      "2026-07-24T00:00:00.000Z",
    );

    const first = await workspace.write("/first.txt", "alpha\nbeta\n", {
      change: later,
    });
    assert.deepEqual(
      {
        additions: first.change.additions,
        deletions: first.change.deletions,
        byte_size: first.change.byte_size,
      },
      { additions: 2, deletions: 0, byte_size: 11 },
    );
    first.change.path = "/tampered-return.txt";
    await workspace.write("/second.txt", "second", { change: earlier });

    const listed = await workspace.listChanges();
    assert.deepEqual(
      listed.map((change) => change.change_id),
      ["change-a", "change-z"],
    );
    listed[0].path = "/tampered-list.txt";
    assert.deepEqual(
      (await workspace.listChanges()).map((change) => change.path),
      ["/second.txt", "/first.txt"],
    );

    await assert.rejects(
      workspace.write("/must-not-exist.txt", "duplicate", {
        change: earlier,
      }),
      hasVfsCode("conflict"),
    );
    await assert.rejects(
      workspace.read("/must-not-exist.txt"),
      hasVfsCode("not_found"),
    );
    assert.equal((await workspace.listChanges()).length, 2);
  });

  test(`${name}: guarded removal preserves changed content`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/notes/today.md": "current",
    });
    const workspace = await backend.create("project");

    await assert.rejects(
      workspace.remove("/notes/today.md", {
        expected_content: "stale",
      }),
      hasVfsCode("conflict"),
    );
    assert.equal(await workspace.read("/notes/today.md"), "current");
    await assert.rejects(
      workspace.remove("/notes"),
      hasVfsCode("is_directory"),
    );
    await workspace.remove("/notes/today.md", {
      expected_content: "current",
    });
    await assert.rejects(
      workspace.read("/notes/today.md"),
      hasVfsCode("not_found"),
    );
  });

  test(`${name}: deleted and replaced workspaces invalidate stale handles`, async (context) => {
    const { backend } = await createHarness(context, create_backend);
    const createdHandle = await backend.create("project");
    await createdHandle.write("/old.txt", "old");
    const openedHandle = await backend.open("project");

    await backend.delete("project");
    await assertWorkspaceAccessRejected(createdHandle, "not_found");
    await assertWorkspaceAccessRejected(openedHandle, "not_found");

    const current = await backend.create("project");
    await current.write("/current.txt", "current");
    await assertWorkspaceAccessRejected(createdHandle, "conflict");
    await assertWorkspaceAccessRejected(openedHandle, "conflict");
    assert.equal(await current.read("/current.txt"), "current");
    await assert.rejects(
      current.read("/ghost.txt"),
      hasVfsCode("not_found"),
    );
    assert.deepEqual(await current.listChanges(), []);
  });

}

export function defineDurableWorkspaceBackendConformance({
  name,
  create_backend,
}) {
  test(`${name}: workspaces survive backend reopening`, async (context) => {
    const harness = await createHarness(context, create_backend);
    assert.equal(
      typeof harness.reopen,
      "function",
      "A durable backend harness must provide reopen().",
    );
    const workspace = await harness.backend.create("project");
    await workspace.write("/persisted.txt", "persisted", {
      change: changeMetadata(
        "persistent-change",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    const reopenedBackend = await harness.reopen();
    const reopened = await reopenedBackend.open("project");
    assert.equal(await reopened.read("/persisted.txt"), "persisted");
    assert.deepEqual(
      (await reopened.listChanges()).map((change) => change.change_id),
      ["persistent-change"],
    );
  });
}

async function createHarness(
  context,
  createBackend,
  seedFiles = {},
) {
  const harness = await createBackend({ seed_files: seedFiles });
  if (!harness?.backend) {
    throw new Error("A workspace backend conformance harness needs a backend.");
  }
  context.after(async () => {
    await harness.close?.();
  });
  return harness;
}

function hasVfsCode(code) {
  return (error) => error?.code === code;
}

function hasBackendCode(code) {
  return (error) => error?.code === code;
}

async function assertWorkspaceAccessRejected(workspace, code) {
  await assert.rejects(workspace.list("/"), hasVfsCode(code));
  await assert.rejects(workspace.read("/old.txt"), hasVfsCode(code));
  await assert.rejects(
    workspace.write("/ghost.txt", "ghost"),
    hasVfsCode(code),
  );
  await assert.rejects(workspace.remove("/old.txt"), hasVfsCode(code));
  await assert.rejects(workspace.listChanges(), hasVfsCode(code));
}

function changeMetadata(changeId, createdAt) {
  return {
    change_id: changeId,
    session_id: "session",
    tool_call_block_id: `block-${changeId}`,
    assistant_message_index: 1,
    tool_call_id: `tool-${changeId}`,
    tool_name: "write_file",
    created_at: createdAt,
  };
}
