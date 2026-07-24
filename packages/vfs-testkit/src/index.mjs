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

    assert.deepEqual(await first.read("/README.md"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "seed",
    });
    const firstWrite = await first.write("/only-a.txt", "project a", {
      change: changeMetadata(
        "project-a-change",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    assert.equal(firstWrite.workspace_revision, 1);
    assert.deepEqual(
      await (await backend.open("project-a")).read("/only-a.txt"),
      {
        workspace_revision: 1,
        path_revision: 1,
        content: "project a",
      },
    );
    await assert.rejects(
      backend.create("project-a"),
      hasBackendCode("already_exists"),
    );

    const second = await backend.create("project-b");
    assert.deepEqual(await second.read("/README.md"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "seed",
    });
    const secondWrite = await second.write("/only-b.txt", "project b", {
      change: changeMetadata(
        "project-b-change",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    assert.equal(secondWrite.workspace_revision, 1);
    await assert.rejects(
      second.read("/only-a.txt"),
      hasVfsCode("not_found"),
    );
    assert.deepEqual(
      (await first.listChanges()).changes.map((change) => change.change_id),
      ["project-a-change"],
    );
    assert.deepEqual(
      (await second.listChanges()).changes.map((change) => change.change_id),
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
    assert.deepEqual(await recreated.listChanges(), {
      workspace_revision: 2,
      changes: [],
    });
    assert.deepEqual(await recreated.read("/README.md"), {
      workspace_revision: 2,
      path_revision: 2,
      content: "seed",
    });
    assert.deepEqual(
      (await second.listChanges()).changes.map((change) => change.change_id),
      ["project-b-change"],
    );
  });

  test(`${name}: explicit initial files replace the configured seed`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/README.md": "configured seed",
    });

    const empty = await backend.create("empty-project", {
      initial_files: [],
    });
    assert.deepEqual(await empty.list("/"), {
      workspace_revision: 0,
      entries: [],
    });
    assert.deepEqual(await empty.listChanges(), {
      workspace_revision: 0,
      changes: [],
    });

    const imported = await backend.create("imported-project", {
      initial_files: [
        {
          path: "notes\\drafts\\..\\today.md",
          content: "today",
        },
        {
          path: "/src/index.ts",
          content: "export {};",
        },
      ],
    });
    assert.deepEqual(await imported.read("/notes/today.md"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "today",
    });
    assert.deepEqual(await imported.read("/src/index.ts"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "export {};",
    });
    assert.deepEqual(await imported.listChanges(), {
      workspace_revision: 0,
      changes: [],
    });
    await assert.rejects(
      imported.read("/README.md"),
      hasVfsCode("not_found"),
    );

    const seeded = await backend.create("seeded-project");
    assert.deepEqual(await seeded.read("/README.md"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "configured seed",
    });
    const explicitlyUndefined = await backend.create("undefined-project", {
      initial_files: undefined,
    });
    assert.deepEqual(await explicitlyUndefined.read("/README.md"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "configured seed",
    });

    const mutableInitialFiles = [
      { path: "/original.txt", content: "original" },
    ];
    const snapshotCreation = backend.create("snapshot-project", {
      initial_files: mutableInitialFiles,
    });
    mutableInitialFiles[0].path = "/mutated.txt";
    mutableInitialFiles[0].content = "mutated";
    mutableInitialFiles.push({
      path: "/added.txt",
      content: "added",
    });
    const snapshot = await snapshotCreation;
    assert.deepEqual(await snapshot.read("/original.txt"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "original",
    });
    await assert.rejects(
      snapshot.read("/mutated.txt"),
      hasVfsCode("not_found"),
    );
    await assert.rejects(
      snapshot.read("/added.txt"),
      hasVfsCode("not_found"),
    );
  });

  test(`${name}: invalid initial files do not partially create a workspace`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/README.md": "configured seed",
    });

    const existing = await backend.create("existing-project");
    await assert.rejects(
      backend.create("existing-project", {
        initial_files: [
          { path: "notes.txt", content: "first" },
          { path: "/notes.txt", content: "second" },
        ],
      }),
      hasBackendCode("already_exists"),
    );
    assert.deepEqual(await existing.read("/README.md"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "configured seed",
    });

    await assert.rejects(
      backend.create("duplicate-project", {
        initial_files: [
          { path: "notes.txt", content: "first" },
          { path: "/notes.txt", content: "second" },
        ],
      }),
      hasVfsCode("conflict"),
    );
    await assert.rejects(
      backend.open("duplicate-project"),
      hasBackendCode("not_found"),
    );

    await assert.rejects(
      backend.create("collision-project", {
        initial_files: [
          { path: "/folder/child.txt", content: "child" },
          { path: "/folder", content: "file" },
        ],
      }),
      hasVfsCode("is_directory"),
    );
    await assert.rejects(
      backend.open("collision-project"),
      hasBackendCode("not_found"),
    );

    await assert.rejects(
      backend.create("ancestor-project", {
        initial_files: [
          { path: "/folder", content: "file" },
          { path: "/folder/child.txt", content: "child" },
        ],
      }),
      hasVfsCode("not_directory"),
    );
    await assert.rejects(
      backend.open("ancestor-project"),
      hasBackendCode("not_found"),
    );

    await assert.rejects(
      backend.create("malformed-project", {
        initial_files: [
          { path: "/invalid.txt", content: new Uint8Array() },
        ],
      }),
      hasVfsCode("invalid_path"),
    );
    await assert.rejects(
      backend.open("malformed-project"),
      hasBackendCode("not_found"),
    );

    const recovered = await backend.create("duplicate-project", {
      initial_files: [{ path: "/valid.txt", content: "valid" }],
    });
    assert.deepEqual(await recovered.read("/valid.txt"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "valid",
    });
    await assert.rejects(
      recovered.read("/README.md"),
      hasVfsCode("not_found"),
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

    assert.deepEqual((await workspace.list("/")).entries, [
      { name: "folder", path: "/folder", kind: "directory", size: 0 },
      { name: "Alpha.txt", path: "/Alpha.txt", kind: "file", size: 1 },
      { name: "Case.txt", path: "/Case.txt", kind: "file", size: 5 },
      { name: "case.txt", path: "/case.txt", kind: "file", size: 5 },
      { name: "e\u0301.txt", path: "/e\u0301.txt", kind: "file", size: 10 },
      { name: "zeta.txt", path: "/zeta.txt", kind: "file", size: 1 },
      { name: "é.txt", path: "/é.txt", kind: "file", size: 2 },
      { name: "🐱.txt", path: "/🐱.txt", kind: "file", size: 4 },
    ]);
    assert.equal((await workspace.read("/Case.txt")).content, "upper");
    assert.equal((await workspace.read("/case.txt")).content, "lower");
    assert.equal((await workspace.read("/e\u0301.txt")).content, "decomposed");
    assert.equal((await workspace.read("/é.txt")).content, "é");

    await workspace.write("notes\\drafts\\..\\today.md", "today");
    assert.equal((await workspace.read("/notes/today.md")).content, "today");
    assert.deepEqual((await workspace.list("/absent")).entries, []);
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
    assert.equal(created.workspace_revision, 1);
    assert.deepEqual(
      {
        path: created.result.path,
        change_kind: created.result.change_kind,
        before_content: created.result.before_content,
        after_content: created.result.after_content,
      },
      {
        path: "/notes.txt",
        change_kind: "created",
        before_content: null,
        after_content: "original",
      },
    );
    const unchanged = await workspace.write("/notes.txt", "original");
    assert.equal(unchanged.workspace_revision, 1);
    assert.equal(unchanged.result.change_kind, "unchanged");
    assert.equal(unchanged.result.change, null);

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
    const winner = await workspace.read("/notes.txt");
    assert.equal(winner.workspace_revision, 2);
    assert.ok(["first", "second"].includes(winner.content));
    await assert.rejects(
      workspace.write("/notes.txt", "stale", {
        expected_content: "original",
      }),
      hasVfsCode("conflict"),
    );
    assert.equal((await workspace.read("/notes.txt")).workspace_revision, 2);
  });

  test(`${name}: workspace revisions are authoritative mutation state`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/seed.txt": "seed",
    });
    const workspace = await backend.create("project");

    const [initialList, initialRead, initialChanges] = await Promise.all([
      workspace.list("/"),
      workspace.read("/seed.txt"),
      workspace.listChanges(),
    ]);
    assert.equal(initialList.workspace_revision, 0);
    assert.equal(initialRead.workspace_revision, 0);
    assert.equal(initialChanges.workspace_revision, 0);
    assert.deepEqual(initialChanges.changes, []);

    const changed = await workspace.write("/seed.txt", "changed");
    assert.equal(changed.workspace_revision, 1);
    assert.equal(changed.result.change_kind, "updated");
    assert.deepEqual(await workspace.listChanges(), {
      workspace_revision: 1,
      changes: [],
    });

    const unchanged = await workspace.write("/seed.txt", "changed", {
      change: changeMetadata(
        "unchanged-receipt",
        "2099-01-01T00:00:00.000Z",
      ),
    });
    assert.equal(unchanged.workspace_revision, 1);
    assert.equal(unchanged.result.change_kind, "unchanged");
    assert.equal(unchanged.result.change, null);

    await assert.rejects(
      workspace.write("/seed.txt", "stale", {
        expected_content: "seed",
      }),
      hasVfsCode("conflict"),
    );
    await assert.rejects(
      workspace.remove("/seed.txt", {
        expected_content: "seed",
      }),
      hasVfsCode("conflict"),
    );
    assert.equal((await workspace.read("/seed.txt")).workspace_revision, 1);

    const removed = await workspace.remove("/seed.txt", {
      expected_content: "changed",
    });
    assert.equal(removed.workspace_revision, 2);
    assert.deepEqual(await workspace.list("/"), {
      workspace_revision: 2,
      entries: [],
    });

    await backend.delete("project");
    const recreated = await backend.create("project");
    assert.equal((await recreated.list("/")).workspace_revision, 3);
    assert.equal((await recreated.read("/seed.txt")).workspace_revision, 3);
  });

  test(`${name}: concurrent disjoint writes share one revision sequence`, async (context) => {
    const { backend } = await createHarness(context, create_backend);
    const firstHandle = await backend.create("project");
    const secondHandle = await backend.open("project");

    const writes = await Promise.all([
      firstHandle.write("/first.txt", "first"),
      secondHandle.write("/second.txt", "second"),
    ]);
    assert.deepEqual(
      writes
        .map((write) => write.workspace_revision)
        .sort((left, right) => left - right),
      [1, 2],
    );

    const firstListing = await firstHandle.list("/");
    const secondListing = await secondHandle.list("/");
    assert.equal(firstListing.workspace_revision, 2);
    assert.equal(secondListing.workspace_revision, 2);
    assert.deepEqual(
      firstListing.entries.map((entry) => entry.path),
      ["/first.txt", "/second.txt"],
    );
    assert.deepEqual(secondListing.entries, firstListing.entries);
    assert.deepEqual(await firstHandle.read("/second.txt"), {
      workspace_revision: 2,
      path_revision: writes[1].workspace_revision,
      content: "second",
    });
    assert.deepEqual(await secondHandle.read("/first.txt"), {
      workspace_revision: 2,
      path_revision: writes[0].workspace_revision,
      content: "first",
    });
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
    assert.equal(first.workspace_revision, 1);
    assert.deepEqual(
      {
        additions: first.result.change.additions,
        deletions: first.result.change.deletions,
        byte_size: first.result.change.byte_size,
      },
      { additions: 2, deletions: 0, byte_size: 11 },
    );
    first.result.change.path = "/tampered-return.txt";
    const second = await workspace.write("/second.txt", "second", {
      change: earlier,
    });
    assert.equal(second.workspace_revision, 2);
    assert.ok(
      Date.parse(second.result.change.created_at) >
        Date.parse(first.result.change.created_at),
    );

    const listed = await workspace.listChanges();
    assert.equal(listed.workspace_revision, 2);
    assert.deepEqual(
      listed.changes.map((change) => change.change_id),
      ["change-z", "change-a"],
    );
    listed.changes[0].path = "/tampered-list.txt";
    assert.deepEqual(
      (await workspace.listChanges()).changes.map((change) => change.path),
      ["/first.txt", "/second.txt"],
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
    assert.deepEqual(
      {
        workspace_revision: (await workspace.listChanges()).workspace_revision,
        change_count: (await workspace.listChanges()).changes.length,
      },
      {
        workspace_revision: 2,
        change_count: 2,
      },
    );
  });

  test(`${name}: individual change lookup is coherent and caller-owned`, async (context) => {
    const { backend } = await createHarness(context, create_backend);
    const workspace = await backend.create("project");

    assert.deepEqual(await workspace.getChange("missing-change"), {
      workspace_revision: 0,
      change: null,
    });

    const write = await workspace.write("/tracked.txt", "tracked", {
      change: changeMetadata(
        "tracked-change",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    const expectedChange = structuredClone(write.result.change);
    assert.deepEqual(await workspace.getChange("tracked-change"), {
      workspace_revision: 1,
      change: expectedChange,
    });

    const callerOwned = await workspace.getChange("tracked-change");
    callerOwned.change.path = "/tampered.txt";
    callerOwned.change.after_content = "tampered";
    assert.deepEqual(await workspace.getChange("tracked-change"), {
      workspace_revision: 1,
      change: expectedChange,
    });

    await workspace.write("/unjournaled.txt", "revision only");
    assert.deepEqual(await workspace.getChange("tracked-change"), {
      workspace_revision: 2,
      change: expectedChange,
    });
    assert.deepEqual(await workspace.getChange("still-missing"), {
      workspace_revision: 2,
      change: null,
    });
  });

  test(`${name}: receipt reverts are atomic and one-time`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/updated.txt": "before",
    });
    const firstHandle = await backend.create("project");
    const secondHandle = await backend.open("project");

    const updated = await firstHandle.write(
      "/updated.txt",
      "after",
      {
        change: changeMetadata(
          "updated-change",
          "2026-07-24T00:00:00.000Z",
        ),
      },
    );
    assert.equal(
      updated.result.change.applied_workspace_revision,
      1,
    );
    assert.equal(
      updated.result.change.reverted_at_workspace_revision,
      null,
    );
    const immutableReceipt = structuredClone(
      (await firstHandle.getChange("updated-change")).change,
    );
    await firstHandle.write("/unrelated.txt", "unrelated");

    const outcomes = await Promise.all([
      firstHandle.revertChange("updated-change"),
      secondHandle.revertChange("updated-change"),
    ]);
    assert.deepEqual(
      outcomes.map((result) => result.revert_outcome).sort(),
      ["already_reverted", "applied"],
    );
    assert.ok(
      outcomes.every(
        (result) =>
          result.workspace_revision === 3 &&
          result.reverted_at_workspace_revision === 3 &&
          result.change.reverted_at_workspace_revision === 3,
      ),
    );
    const appliedOutcome = outcomes.find(
      (result) => result.revert_outcome === "applied",
    );
    appliedOutcome.change.path = "/tampered-result.txt";
    const consumedReceipt = (
      await firstHandle.getChange("updated-change")
    ).change;
    assert.deepEqual(
      {
        ...consumedReceipt,
        reverted_at_workspace_revision: null,
      },
      immutableReceipt,
    );
    assert.equal(
      consumedReceipt.reverted_at_workspace_revision,
      3,
    );
    assert.equal(
      (await firstHandle.listChanges()).changes.length,
      1,
    );
    assert.deepEqual(await firstHandle.read("/updated.txt"), {
      workspace_revision: 3,
      path_revision: 3,
      content: "before",
    });

    await firstHandle.write("/updated.txt", "newer");
    const replay = await secondHandle.revertChange("updated-change");
    assert.deepEqual(
      {
        workspace_revision: replay.workspace_revision,
        revert_outcome: replay.revert_outcome,
        reverted_at_workspace_revision:
          replay.reverted_at_workspace_revision,
      },
      {
        workspace_revision: 4,
        revert_outcome: "already_reverted",
        reverted_at_workspace_revision: 3,
      },
    );
    assert.deepEqual(await firstHandle.read("/updated.txt"), {
      workspace_revision: 4,
      path_revision: 4,
      content: "newer",
    });
    assert.equal(
      (await firstHandle.getChange("updated-change")).change
        .reverted_at_workspace_revision,
      3,
    );
  });

  test(`${name}: reverting a creation removes only its original path generation`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/empty.txt": "",
    });
    const workspace = await backend.create("project");
    await workspace.write("/empty.txt", "filled", {
      change: changeMetadata(
        "empty-update",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    const restoredEmpty = await workspace.revertChange(
      "empty-update",
    );
    assert.equal(restoredEmpty.workspace_revision, 2);
    assert.deepEqual(await workspace.read("/empty.txt"), {
      workspace_revision: 2,
      path_revision: 2,
      content: "",
    });

    await workspace.write("/created.txt", "created", {
      change: changeMetadata(
        "created-change",
        "2026-07-24T00:00:01.000Z",
      ),
    });

    const reverted = await workspace.revertChange("created-change");
    assert.equal(reverted.workspace_revision, 4);
    assert.equal(reverted.revert_outcome, "applied");
    assert.equal(reverted.reverted_at_workspace_revision, 4);
    await assert.rejects(
      workspace.read("/created.txt"),
      hasVfsCode("not_found"),
    );
    assert.equal(
      (await workspace.listChanges()).workspace_revision,
      4,
    );
    assert.equal((await workspace.listChanges()).changes.length, 2);
  });

  test(`${name}: path revisions reject edit-away/edit-back ABA reverts`, async (context) => {
    const { backend } = await createHarness(context, create_backend, {
      "/updated.txt": "before",
    });
    const workspace = await backend.create("project");
    await workspace.write("/updated.txt", "after", {
      change: changeMetadata(
        "aba-update",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    await workspace.write("/updated.txt", "before");

    assert.deepEqual(await workspace.read("/updated.txt"), {
      workspace_revision: 2,
      path_revision: 2,
      content: "before",
    });
    await assert.rejects(
      workspace.revertChange("aba-update"),
      hasVfsCode("conflict"),
    );
    await workspace.write("/updated.txt", "after");
    assert.deepEqual(await workspace.read("/updated.txt"), {
      workspace_revision: 3,
      path_revision: 3,
      content: "after",
    });
    assert.equal(
      (await workspace.getChange("aba-update")).change
        .reverted_at_workspace_revision,
      null,
    );

    await workspace.write("/created.txt", "same", {
      change: changeMetadata(
        "aba-create",
        "2026-07-24T00:00:01.000Z",
      ),
    });
    await workspace.remove("/created.txt");
    await assert.rejects(
      workspace.revertChange("aba-create"),
      hasVfsCode("conflict"),
    );
    await workspace.write("/created.txt", "same");
    await assert.rejects(
      workspace.revertChange("aba-create"),
      hasVfsCode("conflict"),
    );
    assert.deepEqual(await workspace.read("/created.txt"), {
      workspace_revision: 6,
      path_revision: 6,
      content: "same",
    });
  });

  test(`${name}: missing receipts and conflicted reverts never mutate`, async (context) => {
    const { backend } = await createHarness(context, create_backend);
    const workspace = await backend.create("project");

    await assert.rejects(
      workspace.revertChange("missing-change"),
      hasVfsCode("not_found"),
    );
    assert.equal((await workspace.list("/")).workspace_revision, 0);

    await workspace.write("/tracked.txt", "original", {
      change: changeMetadata(
        "tracked-change",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    await workspace.write("/tracked.txt", "changed");
    await assert.rejects(
      workspace.revertChange("tracked-change"),
      hasVfsCode("conflict"),
    );
    assert.deepEqual(await workspace.read("/tracked.txt"), {
      workspace_revision: 2,
      path_revision: 2,
      content: "changed",
    });
  });

  test(`${name}: receipt path revisions follow recreated project sequences`, async (context) => {
    const { backend } = await createHarness(context, create_backend);
    const original = await backend.create("project");
    await original.write("/old.txt", "old");
    await backend.delete("project");

    const recreated = await backend.create("project", {
      initial_files: [{ path: "/notes.txt", content: "before" }],
    });
    const write = await recreated.write("/notes.txt", "after", {
      change: changeMetadata(
        "recreated-change",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    assert.equal(write.workspace_revision, 3);
    assert.equal(
      write.result.change.applied_workspace_revision,
      3,
    );
    assert.deepEqual(await recreated.read("/notes.txt"), {
      workspace_revision: 3,
      path_revision: 3,
      content: "after",
    });

    const reverted = await recreated.revertChange(
      "recreated-change",
    );
    assert.equal(reverted.workspace_revision, 4);
    assert.equal(reverted.reverted_at_workspace_revision, 4);
    assert.equal(
      reverted.change.applied_workspace_revision,
      3,
    );
    assert.deepEqual(await recreated.read("/notes.txt"), {
      workspace_revision: 4,
      path_revision: 4,
      content: "before",
    });
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
    assert.deepEqual(await workspace.read("/notes/today.md"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "current",
    });
    await assert.rejects(
      workspace.remove("/notes"),
      hasVfsCode("is_directory"),
    );
    const removed = await workspace.remove("/notes/today.md", {
      expected_content: "current",
    });
    assert.equal(removed.workspace_revision, 1);
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
    assert.deepEqual(await current.read("/current.txt"), {
      workspace_revision: 3,
      path_revision: 3,
      content: "current",
    });
    await assert.rejects(
      current.read("/ghost.txt"),
      hasVfsCode("not_found"),
    );
    assert.deepEqual(await current.listChanges(), {
      workspace_revision: 3,
      changes: [],
    });
  });

}

export function defineDurableWorkspaceBackendConformance({
  name,
  create_backend,
}) {
  test(`${name}: reverted receipts remain consumed after reopening`, async (context) => {
    const harness = await createHarness(
      context,
      create_backend,
      { "/notes.txt": "before" },
    );
    assert.equal(
      typeof harness.reopen,
      "function",
      "A durable backend harness must provide reopen().",
    );
    const workspace = await harness.backend.create("project");
    await workspace.write("/notes.txt", "after", {
      change: changeMetadata(
        "durable-revert",
        "2026-07-24T00:00:00.000Z",
      ),
    });
    const applied = await workspace.revertChange("durable-revert");
    assert.equal(applied.reverted_at_workspace_revision, 2);

    const reopenedBackend = await harness.reopen();
    const reopened = await reopenedBackend.open("project");
    const persisted = await reopened.getChange("durable-revert");
    assert.equal(
      persisted.change.applied_workspace_revision,
      1,
    );
    assert.equal(
      persisted.change.reverted_at_workspace_revision,
      2,
    );
    const replay = await reopened.revertChange("durable-revert");
    assert.equal(replay.workspace_revision, 2);
    assert.equal(replay.revert_outcome, "already_reverted");
    assert.equal(replay.reverted_at_workspace_revision, 2);
    assert.deepEqual(await reopened.read("/notes.txt"), {
      workspace_revision: 2,
      path_revision: 2,
      content: "before",
    });
  });

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
    assert.deepEqual(await reopened.read("/persisted.txt"), {
      workspace_revision: 1,
      path_revision: 1,
      content: "persisted",
    });
    assert.deepEqual(
      (await reopened.listChanges()).changes.map(
        (change) => change.change_id,
      ),
      ["persistent-change"],
    );
    const persistentChange = await reopened.getChange(
      "persistent-change",
    );
    assert.equal(persistentChange.workspace_revision, 1);
    assert.equal(
      persistentChange.change?.change_id,
      "persistent-change",
    );
  });

  test(`${name}: initial files survive reopening at revision zero`, async (context) => {
    const harness = await createHarness(context, create_backend, {
      "/README.md": "configured seed",
    });
    assert.equal(
      typeof harness.reopen,
      "function",
      "A durable backend harness must provide reopen().",
    );
    await harness.backend.create("project", {
      initial_files: [
        { path: "/imported.txt", content: "imported" },
        { path: "nested\\file.txt", content: "nested" },
      ],
    });

    const reopenedBackend = await harness.reopen();
    const reopened = await reopenedBackend.open("project");
    assert.deepEqual(await reopened.read("/imported.txt"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "imported",
    });
    assert.deepEqual(await reopened.read("/nested/file.txt"), {
      workspace_revision: 0,
      path_revision: 0,
      content: "nested",
    });
    assert.deepEqual(await reopened.listChanges(), {
      workspace_revision: 0,
      changes: [],
    });
    await assert.rejects(
      reopened.read("/README.md"),
      hasVfsCode("not_found"),
    );
  });

  test(`${name}: unjournaled mutation revisions survive backend reopening`, async (context) => {
    const harness = await createHarness(context, create_backend);
    assert.equal(
      typeof harness.reopen,
      "function",
      "A durable backend harness must provide reopen().",
    );
    const workspace = await harness.backend.create("project");
    assert.equal(
      (await workspace.write("/kept.txt", "kept")).workspace_revision,
      1,
    );
    assert.equal(
      (await workspace.write("/removed.txt", "removed")).workspace_revision,
      2,
    );
    assert.equal(
      (
        await workspace.remove("/removed.txt", {
          expected_content: "removed",
        })
      ).workspace_revision,
      3,
    );

    const reopenedBackend = await harness.reopen();
    const reopened = await reopenedBackend.open("project");
    assert.deepEqual(await reopened.read("/kept.txt"), {
      workspace_revision: 3,
      path_revision: 1,
      content: "kept",
    });
    assert.deepEqual(await reopened.list("/"), {
      workspace_revision: 3,
      entries: [
        {
          name: "kept.txt",
          path: "/kept.txt",
          kind: "file",
          size: 4,
        },
      ],
    });
    assert.deepEqual(await reopened.listChanges(), {
      workspace_revision: 3,
      changes: [],
    });
  });

  test(`${name}: receipt timestamps remain monotonic across backend reopening`, async (context) => {
    const harness = await createHarness(context, create_backend);
    assert.equal(
      typeof harness.reopen,
      "function",
      "A durable backend harness must provide reopen().",
    );
    const workspace = await harness.backend.create("project");
    const first = await workspace.write("/first.txt", "first", {
      change: changeMetadata(
        "first-change",
        "2026-07-24T00:00:00.010Z",
      ),
    });
    const firstTimestamp = first.result.change.created_at;

    const reopenedBackend = await harness.reopen();
    const reopened = await reopenedBackend.open("project");
    const second = await reopened.write("/second.txt", "second", {
      change: changeMetadata(
        "second-change",
        "2026-07-24T00:00:00.005Z",
      ),
    });
    const secondTimestamp = second.result.change.created_at;
    assert.equal(second.workspace_revision, 2);
    assert.equal(
      Date.parse(secondTimestamp),
      Date.parse(firstTimestamp) + 1,
    );

    const changes = await reopened.listChanges();
    assert.equal(changes.workspace_revision, 2);
    assert.deepEqual(
      changes.changes.map((change) => ({
        change_id: change.change_id,
        created_at: change.created_at,
      })),
      [
        {
          change_id: "first-change",
          created_at: firstTimestamp,
        },
        {
          change_id: "second-change",
          created_at: secondTimestamp,
        },
      ],
    );
  });

  test(`${name}: recreation preserves project revision monotonicity`, async (context) => {
    const harness = await createHarness(context, create_backend);
    assert.equal(
      typeof harness.reopen,
      "function",
      "A durable backend harness must provide reopen().",
    );
    const workspace = await harness.backend.create("project");
    assert.equal(
      (await workspace.write("/old.txt", "old")).workspace_revision,
      1,
    );
    await harness.backend.delete("project");

    const reopenedBackend = await harness.reopen();
    const recreated = await reopenedBackend.create("project");
    assert.deepEqual(await recreated.list("/"), {
      workspace_revision: 2,
      entries: [],
    });
    assert.equal(
      (await recreated.write("/new.txt", "new")).workspace_revision,
      3,
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
  await assert.rejects(
    workspace.getChange("old-change"),
    hasVfsCode(code),
  );
  await assert.rejects(
    workspace.revertChange("old-change"),
    hasVfsCode(code),
  );
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
