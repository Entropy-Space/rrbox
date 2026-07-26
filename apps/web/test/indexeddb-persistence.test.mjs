import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  SESSION_DOCUMENT_FORMAT_VERSION,
} from "@researchbox/project-store";
import {
  defineDurableWorkspaceBackendConformance,
  defineWorkspaceBackendConformance,
} from "@researchbox/vfs-testkit";
import { WorkspaceCorruptionError } from "@researchbox/vfs";
import { capturePortableWorkspace } from "@researchbox/workspace-archive/snapshot";
import {
  IndexedDbWorkspaceBackend,
  IndexedDbProjectStore,
  ResearchBoxDatabase,
} from "../browser/persistence/index.ts";

const indexedDbConformance = {
  name: "IndexedDB workspace backend",
  async create_backend({ seed_files }) {
    const factory = new IDBFactory();
    const databaseName = `researchbox-conformance-${crypto.randomUUID()}`;
    let database = new ResearchBoxDatabase(factory, databaseName);
    let backend = new IndexedDbWorkspaceBackend(database, seed_files);

    return {
      backend,
      async reopen() {
        database.close();
        database = new ResearchBoxDatabase(factory, databaseName);
        backend = new IndexedDbWorkspaceBackend(database, {});
        return backend;
      },
      close() {
        database.close();
      },
    };
  },
};

defineWorkspaceBackendConformance(indexedDbConformance);
defineDurableWorkspaceBackendConformance(indexedDbConformance);

test("IndexedDB export captures all files with one bulk read", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-bulk-snapshot-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {});
  const initialFiles = Array.from({ length: 64 }, (_, index) => ({
    path: `/nested/${index.toString().padStart(2, "0")}/file.txt`,
    content: `content-${index}`,
  }));
  const workspace = await backend.create("project-1", {
    initial_files: initialFiles,
  });
  workspace.list = async () => {
    throw new Error("Bulk capture must not traverse IndexedDB listings.");
  };
  workspace.read = async () => {
    throw new Error("Bulk capture must not reload IndexedDB for each file.");
  };

  const captured = await capturePortableWorkspace(workspace);

  assert.equal(captured.workspace_revision, 0);
  assert.deepEqual(captured.snapshot.files, initialFiles);
  database.close();
});

test("IndexedDB bulk snapshots keep file content and revision coherent", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-coherent-snapshot-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {
    "/value.txt": "before",
  });
  const workspace = await backend.create("project-1");

  const snapshotPromise = workspace.readFilesSnapshot();
  const writePromise = workspace.write("/value.txt", "after");
  const [snapshot, write] = await Promise.all([
    snapshotPromise,
    writePromise,
  ]);
  const value = snapshot.files.find(
    (file) => file.path === "/value.txt",
  )?.content;

  assert.equal(write.workspace_revision, 1);
  assert.ok(
    (snapshot.workspace_revision === 0 && value === "before") ||
      (snapshot.workspace_revision === 1 && value === "after"),
    `Revision ${snapshot.workspace_revision} must match its captured content.`,
  );
  database.close();
});

test("IndexedDB orphan reconciliation deletes only unknown active workspaces", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-orphan-reconciliation-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {});
  const retained = await backend.create("retained");
  const orphan = await backend.create("orphan");
  await retained.write("/kept.txt", "kept");
  await orphan.write("/removed.txt", "removed");

  await backend.reconcileOrphanedWorkspaces(["retained"]);
  await backend.reconcileOrphanedWorkspaces(["retained"]);

  assert.equal(
    (await (await backend.open("retained")).read("/kept.txt")).content,
    "kept",
  );
  await assert.rejects(
    backend.open("orphan"),
    (error) => error?.code === "not_found",
  );
  const recreated = await backend.create("orphan", {
    initial_files: [],
  });
  assert.equal((await recreated.list("/")).workspace_revision, 2);
  database.close();
});

test("IndexedDB project state and files survive reopening the database", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-test-${crypto.randomUUID()}`;
  const firstDatabase = new ResearchBoxDatabase(factory, databaseName);
  const firstStore = new IndexedDbProjectStore(firstDatabase);
  const firstProvider = new IndexedDbWorkspaceBackend(firstDatabase, {
    "/README.md": "seed",
  });
  const state = createState();

  await firstProvider.create("project-1");
  await firstStore.save(state, null);
  await firstStore.saveInputDraft({
    project_id: "project-1",
    session_id: null,
    input_draft: "A new chat draft",
  });
  await firstStore.saveInputDraft({
    project_id: "project-1",
    session_id: "session-1",
    input_draft: "A session draft",
  });
  await (await firstProvider.open("project-1")).write("/notes.txt", "persisted");

  const expectedState = structuredClone(state);
  expectedState.state_revision = 3;
  expectedState.projects[0].new_chat_draft = "A new chat draft";
  expectedState.documents[0].input_draft = "A session draft";

  const secondDatabase = new ResearchBoxDatabase(factory, databaseName);
  const secondStore = new IndexedDbProjectStore(secondDatabase);
  const secondProvider = new IndexedDbWorkspaceBackend(secondDatabase, {});
  assert.deepEqual(await secondStore.load(), expectedState);
  assert.equal(
    (await (await secondProvider.open("project-1")).read("/notes.txt")).content,
    "persisted",
  );

  await secondProvider.create("project-2");
  assert.deepEqual(
    (await (await secondProvider.open("project-2")).list("/")).entries,
    [],
  );
  await assert.rejects(
    secondProvider.create("project-2"),
    /already exists/,
  );
  await assert.rejects(
    (await secondProvider.open("project-2")).read("/notes.txt"),
    /File not found/,
  );
  await secondProvider.delete("project-1");
  await assert.rejects(
    secondProvider.open("project-1"),
    /does not exist/,
  );
  await assert.rejects(
    secondProvider.open("project-never-created"),
    /does not exist/,
  );
});

test("IndexedDB seed validation cannot leave a partial workspace", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-invalid-seed-${crypto.randomUUID()}`,
  );

  assert.throws(
    () =>
      new IndexedDbWorkspaceBackend(database, {
        "/valid.txt": "valid",
        "../../invalid.txt": "invalid",
      }),
    (error) => error.code === "invalid_path",
  );
  assert.throws(
    () =>
      new IndexedDbWorkspaceBackend(database, {
        "/a": "file",
        "/a/b": "nested",
      }),
    (error) => error.code === "not_directory",
  );

  const provider = new IndexedDbWorkspaceBackend(database, {});
  await assert.rejects(provider.open("project-1"), /does not exist/);
  database.close();
});

test("IndexedDB atomically persists file writes and workspace change receipts", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-file-changes-${crypto.randomUUID()}`;
  const firstDatabase = new ResearchBoxDatabase(factory, databaseName);
  const firstProvider = new IndexedDbWorkspaceBackend(firstDatabase, {});
  const filesystem = await firstProvider.create("project-1");

  const createdWrite = await filesystem.write(
    "/notes.txt",
    "alpha\nbeta\n",
    { change: workspaceChangeMetadata("change-1", "write_file") },
  );
  const created = createdWrite.result;
  assert.equal(createdWrite.workspace_revision, 1);
  assert.equal(created.change_kind, "created");
  assert.deepEqual(
    {
      additions: created.change.additions,
      deletions: created.change.deletions,
      byte_size: created.change.byte_size,
    },
    { additions: 2, deletions: 0, byte_size: 11 },
  );

  const updatedWrite = await filesystem.write(
    "/notes.txt",
    "alpha\ngamma\n",
    {
      expected_content: "alpha\nbeta\n",
      change: workspaceChangeMetadata("change-2", "replace_text"),
    },
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
    "/notes.txt",
    "alpha\ngamma\n",
    { change: workspaceChangeMetadata("change-3", "write_file") },
  );
  const unchanged = unchangedWrite.result;
  assert.equal(unchangedWrite.workspace_revision, 2);
  assert.equal(unchanged.change_kind, "unchanged");
  assert.equal(unchanged.change, null);
  firstDatabase.close();

  const reopenedDatabase = new ResearchBoxDatabase(factory, databaseName);
  const reopenedProvider = new IndexedDbWorkspaceBackend(
    reopenedDatabase,
    {},
  );
  const reopened = await reopenedProvider.open("project-1");
  assert.deepEqual(await reopened.read("/notes.txt"), {
    workspace_revision: 2,
    path_revision: 2,
    content: "alpha\ngamma\n",
  });
  assert.deepEqual(
    (await reopened.listChanges()).changes.map(
      (change) => ({
        change_id: change.change_id,
        path: change.path,
        change_kind: change.change_kind,
        before_content: change.before_content,
        after_content: change.after_content,
      }),
    ),
    [
      {
        change_id: "change-1",
        path: "/notes.txt",
        change_kind: "created",
        before_content: null,
        after_content: "alpha\nbeta\n",
      },
      {
        change_id: "change-2",
        path: "/notes.txt",
        change_kind: "updated",
        before_content: "alpha\nbeta\n",
        after_content: "alpha\ngamma\n",
      },
    ],
  );

  await assert.rejects(
    reopened.write("/duplicate.txt", "must roll back", {
      change: workspaceChangeMetadata("change-2", "write_file"),
    }),
    (error) => error.code === "conflict",
  );
  await assert.rejects(reopened.read("/duplicate.txt"), /File not found/);

  await reopenedProvider.delete("project-1");
  const recreated = await reopenedProvider.create("project-1");
  assert.deepEqual(await recreated.list("/"), {
    workspace_revision: 3,
    entries: [],
  });
  assert.deepEqual(await recreated.listChanges(), {
    workspace_revision: 3,
    changes: [],
  });
  reopenedDatabase.close();
});

test("IndexedDB journaled removal rolls back when marker publication fails", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-remove-failure-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {
    "/notes.txt": "before",
  });
  const workspace = await backend.create("project-1");
  const restoreOpen = failNextMarkerPublication(database);

  try {
    await assert.rejects(
      workspace.remove("/notes.txt", {
        expected_content: "before",
        change: workspaceChangeMetadata(
          "failed-remove",
          "remove_file",
        ),
      }),
      /injected marker publication failure/,
    );
  } finally {
    restoreOpen();
  }

  assert.deepEqual(await workspace.getPathState("/notes.txt"), {
    workspace_revision: 0,
    path: "/notes.txt",
    kind: "file",
    path_revision: 0,
    content: "before",
  });
  assert.deepEqual(await workspace.listChanges(), {
    workspace_revision: 0,
    changes: [],
  });
  database.close();
});

test("IndexedDB preserves receipts with redundant malformed assistant indexes", async (t) => {
  const invalidIndexes = [
    { name: "missing", value: undefined, removes_field: true },
    { name: "null", value: null },
    { name: "string", value: "1" },
    { name: "negative", value: -1 },
    { name: "fractional", value: 1.5 },
    { name: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
    { name: "NaN", value: Number.NaN },
    { name: "infinity", value: Number.POSITIVE_INFINITY },
  ];

  for (const testCase of invalidIndexes) {
    await t.test(testCase.name, async () => {
      const factory = new IDBFactory();
      const database = new ResearchBoxDatabase(
        factory,
        `researchbox-legacy-index-${crypto.randomUUID()}`,
      );
      const backend = new IndexedDbWorkspaceBackend(database, {
        "/notes.txt": "before",
      });
      const workspace = await backend.create("project-1");
      const changeId = `legacy-index-${testCase.name}`;
      await workspace.write("/notes.txt", "after", {
        change: workspaceChangeMetadata(changeId, "write_file"),
      });

      const connection = await database.open();
      const damage = connection.transaction("file_changes", "readwrite");
      const damageComplete = transactionComplete(damage);
      const store = damage.objectStore("file_changes");
      const stored = await requestValue(
        store.get(["project-1", changeId]),
      );
      if (testCase.removes_field) {
        delete stored.assistant_message_index;
      } else {
        stored.assistant_message_index = testCase.value;
      }
      store.put(stored);
      await damageComplete;

      const journal = await workspace.listChanges();
      assert.equal(journal.quarantine_status, undefined);
      assert.equal(journal.changes.length, 1);
      assert.equal(journal.changes[0].assistant_message_index, null);
      assert.equal(
        (await workspace.getChange(changeId)).change
          .assistant_message_index,
        null,
      );
      assert.equal(
        (await workspace.revertChange(changeId)).revert_outcome,
        "applied",
      );
      assert.equal((await workspace.read("/notes.txt")).content, "before");

      const verification = connection.transaction(
        ["file_changes", "file_change_quarantines"],
        "readonly",
      );
      const verificationComplete = transactionComplete(verification);
      const [persisted, quarantines] = await Promise.all([
        requestValue(
          verification
            .objectStore("file_changes")
            .get(["project-1", changeId]),
        ),
        requestValue(
          verification
            .objectStore("file_change_quarantines")
            .index("by_project")
            .getAll("project-1"),
        ),
      ]);
      await verificationComplete;
      assert.equal(quarantines.length, 0);
      if (testCase.removes_field) {
        assert.equal(
          Object.hasOwn(persisted, "assistant_message_index"),
          false,
        );
      } else {
        assert.equal(
          Object.is(
            persisted.assistant_message_index,
            testCase.value,
          ),
          true,
        );
      }
      database.close();
    });
  }
});

test("IndexedDB recovers a legacy message identity without an assistant index", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-legacy-message-index-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {});
  const workspace = await backend.create("project-1");
  await workspace.write("/legacy.txt", "after", {
    change: workspaceChangeMetadata("legacy-message", "write_file"),
  });

  const connection = await database.open();
  const damage = connection.transaction("file_changes", "readwrite");
  const damageComplete = transactionComplete(damage);
  const store = damage.objectStore("file_changes");
  const stored = await requestValue(
    store.get(["project-1", "legacy-message"]),
  );
  delete stored.tool_call_block_id;
  delete stored.assistant_message_index;
  stored.message_id = "legacy-assistant-message";
  store.put(stored);
  await damageComplete;

  const listed = await workspace.listChanges();
  assert.equal(listed.quarantine_status, undefined);
  assert.equal(listed.changes[0].tool_call_block_id, null);
  assert.equal(
    listed.changes[0].legacy_message_id,
    "legacy-assistant-message",
  );
  assert.equal(listed.changes[0].assistant_message_index, null);
  database.close();
});

test("IndexedDB project replacement clears receipt quarantine markers", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-quarantine-lifecycle-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {});
  const workspace = await backend.create("project-1");
  await workspace.write("/invalid.txt", "after", {
    change: workspaceChangeMetadata("invalid-identity", "write_file"),
  });

  const connection = await database.open();
  const damage = connection.transaction("file_changes", "readwrite");
  const damageComplete = transactionComplete(damage);
  const changeStore = damage.objectStore("file_changes");
  const stored = await requestValue(
    changeStore.get(["project-1", "invalid-identity"]),
  );
  delete stored.tool_call_block_id;
  stored.assistant_message_index = -1;
  changeStore.put(stored);
  await damageComplete;

  assert.equal(
    (await workspace.listChanges()).quarantine_status
      .quarantined_receipt_count,
    1,
  );
  await backend.delete("project-1");
  const recreated = await backend.create("project-1");
  assert.deepEqual(await recreated.listChanges(), {
    workspace_revision: 2,
    changes: [],
  });

  const verification = connection.transaction(
    "file_change_quarantines",
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  const quarantines = await requestValue(
    verification
      .objectStore("file_change_quarantines")
      .index("by_project")
      .getAll("project-1"),
  );
  await verificationComplete;
  assert.deepEqual(quarantines, []);
  database.close();
});

test("IndexedDB keeps malformed receipts isolated when a quarantine marker cannot be saved", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-pending-quarantine-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {});
  const workspace = await backend.create("project-1");
  await workspace.write("/invalid.txt", "after", {
    change: workspaceChangeMetadata("pending-quarantine", "write_file"),
  });

  const connection = await database.open();
  const damage = connection.transaction("file_changes", "readwrite");
  const damageComplete = transactionComplete(damage);
  const store = damage.objectStore("file_changes");
  const stored = await requestValue(
    store.get(["project-1", "pending-quarantine"]),
  );
  delete stored.tool_call_block_id;
  stored.assistant_message_index = -1;
  store.put(stored);
  await damageComplete;

  const originalOpen = database.open.bind(database);
  database.open = async () => {
    const current = await originalOpen();
    return new Proxy(current, {
      get(target, property) {
        if (property !== "transaction") {
          return Reflect.get(target, property, target);
        }
        return (storeNames, mode) => {
          if (
            Array.isArray(storeNames) &&
            storeNames.includes("file_change_quarantines") &&
            mode === "readwrite"
          ) {
            throw new DOMException(
              "Quarantine storage is full.",
              "QuotaExceededError",
            );
          }
          return target.transaction(storeNames, mode);
        };
      },
    });
  };

  assert.deepEqual(await workspace.listChanges(), {
    workspace_revision: 1,
    changes: [],
    quarantine_status: {
      quarantined_receipt_count: 1,
      pending_receipt_count: 1,
    },
  });

  database.open = originalOpen;
  assert.deepEqual(await workspace.listChanges(), {
    workspace_revision: 1,
    changes: [],
    quarantine_status: {
      quarantined_receipt_count: 1,
      pending_receipt_count: 0,
    },
  });
  database.close();
});

test("a repaired IndexedDB receipt takes precedence over its stale quarantine marker", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-stale-quarantine-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {
    "/notes.txt": "before",
  });
  const workspace = await backend.create("project-1");
  await workspace.write("/notes.txt", "after", {
    change: workspaceChangeMetadata("repaired-receipt", "write_file"),
  });

  const connection = await database.open();
  const damage = connection.transaction("file_changes", "readwrite");
  const damageComplete = transactionComplete(damage);
  const store = damage.objectStore("file_changes");
  const valid = await requestValue(
    store.get(["project-1", "repaired-receipt"]),
  );
  const invalid = structuredClone(valid);
  invalid.after_content = 42;
  store.put(invalid);
  await damageComplete;

  assert.equal(
    (await workspace.listChanges()).quarantine_status
      .quarantined_receipt_count,
    1,
  );

  const repair = connection.transaction("file_changes", "readwrite");
  const repairComplete = transactionComplete(repair);
  repair.objectStore("file_changes").put(valid);
  await repairComplete;

  const journal = await workspace.listChanges();
  assert.equal(journal.quarantine_status, undefined);
  assert.equal(journal.changes.length, 1);
  assert.equal(
    (await workspace.getChange("repaired-receipt")).change.change_id,
    "repaired-receipt",
  );
  assert.equal(
    (await workspace.revertChange("repaired-receipt"))
      .revert_outcome,
    "applied",
  );
  assert.equal((await workspace.read("/notes.txt")).content, "before");
  database.close();
});

test("IndexedDB reverts fail closed on corrupt persisted state", async (t) => {
  const cases = [
    {
      name: "invalid change kind",
      corrupts_receipt: true,
      corrupt({ change }) {
        change.change_kind = "removed";
      },
    },
    {
      name: "remove tool on a write receipt",
      corrupts_receipt: true,
      corrupt({ change }) {
        change.tool_name = "remove_file";
      },
    },
    {
      name: "write tool on a deletion receipt",
      corrupts_receipt: true,
      corrupt({ change }) {
        change.change_kind = "deleted";
        change.before_content = "after";
        change.after_content = null;
        change.additions = 0;
        change.deletions = 1;
        change.byte_size = 0;
      },
    },
    {
      name: "future applied revision",
      corrupts_receipt: true,
      corrupt({ change, marker }) {
        change.applied_workspace_revision =
          marker.workspace_revision + 1;
      },
    },
    {
      name: "malformed receipt content",
      corrupts_receipt: true,
      corrupt({ change }) {
        change.after_content = 42;
      },
    },
    {
      name: "non-canonical receipt path",
      corrupts_receipt: true,
      corrupt({ change }) {
        change.path = "notes.txt";
      },
    },
    {
      name: "future file path revision",
      corrupt({ file, marker }) {
        file.path_revision = marker.workspace_revision + 1;
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const factory = new IDBFactory();
      const database = new ResearchBoxDatabase(
        factory,
        `researchbox-corrupt-revert-${crypto.randomUUID()}`,
      );
      const backend = new IndexedDbWorkspaceBackend(database, {
        "/notes.txt": "before",
      });
      const workspace = await backend.create("project-1");
      await workspace.write("/notes.txt", "after", {
        change: workspaceChangeMetadata(
          "corrupt-revert",
          "write_file",
        ),
      });

      const connection = await database.open();
      const damage = connection.transaction(
        ["project_filesystems", "files", "file_changes"],
        "readwrite",
      );
      const completion = transactionComplete(damage);
      const [marker, file, change] = await Promise.all([
        requestValue(
          damage
            .objectStore("project_filesystems")
            .get("project-1"),
        ),
        requestValue(
          damage
            .objectStore("files")
            .get(["project-1", "/notes.txt"]),
        ),
        requestValue(
          damage
            .objectStore("file_changes")
            .get(["project-1", "corrupt-revert"]),
        ),
      ]);
      testCase.corrupt({ marker, file, change });
      damage.objectStore("files").put(file);
      damage.objectStore("file_changes").put(change);
      await completion;

      if (testCase.corrupts_receipt) {
        await assert.rejects(
          workspace.getChange("corrupt-revert"),
          (error) => error instanceof WorkspaceCorruptionError,
        );
        assert.deepEqual(await workspace.listChanges(), {
          workspace_revision: 1,
          changes: [],
          quarantine_status: {
            quarantined_receipt_count: 1,
            pending_receipt_count: 0,
          },
        });
        assert.deepEqual(await workspace.listChanges(), {
          workspace_revision: 1,
          changes: [],
          quarantine_status: {
            quarantined_receipt_count: 1,
            pending_receipt_count: 0,
          },
        });
      }
      await assert.rejects(
        workspace.revertChange("corrupt-revert"),
        (error) => error instanceof WorkspaceCorruptionError,
      );
      const current = await workspace.read("/notes.txt");
      assert.equal(current.workspace_revision, 1);
      assert.equal(current.content, "after");
      const verification = connection.transaction(
        ["file_changes", "file_change_quarantines"],
        "readonly",
      );
      const verificationComplete = transactionComplete(verification);
      const [currentChange, quarantines] = await Promise.all([
        requestValue(
          verification
            .objectStore("file_changes")
            .get(["project-1", "corrupt-revert"]),
        ),
        requestValue(
          verification
            .objectStore("file_change_quarantines")
            .index("by_project")
            .getAll("project-1"),
        ),
      ]);
      await verificationComplete;
      assert.equal(
        currentChange.reverted_at_workspace_revision,
        null,
      );
      assert.equal(
        quarantines.length,
        testCase.corrupts_receipt ? 1 : 0,
      );
      if (testCase.corrupts_receipt) {
        assert.equal(
          quarantines[0].source_change_id,
          "corrupt-revert",
        );
        assert.equal(quarantines[0].reason_code, "invalid_receipt");
      }
      database.close();
    });
  }
});

test("IndexedDB rejects receipts forged at a replacement incarnation baseline", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-baseline-forgery-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbWorkspaceBackend(database, {});
  await backend.create("project-1");
  await backend.delete("project-1");
  const workspace = await backend.create("project-1", {
    initial_files: [{ path: "/notes.txt", content: "after" }],
  });
  await workspace.write("/receipt-source.txt", "source", {
    change: workspaceChangeMetadata(
      "baseline-forgery",
      "write_file",
    ),
  });

  const connection = await database.open();
  const damage = connection.transaction(
    ["project_filesystems", "file_changes"],
    "readwrite",
  );
  const completion = transactionComplete(damage);
  const marker = await requestValue(
    damage.objectStore("project_filesystems").get("project-1"),
  );
  const change = await requestValue(
    damage
      .objectStore("file_changes")
      .get(["project-1", "baseline-forgery"]),
  );
  Object.assign(change, {
    path: "/notes.txt",
    change_kind: "updated",
    before_content: "before",
    after_content: "after",
    additions: 1,
    deletions: 1,
    byte_size: 5,
    applied_workspace_revision:
      marker.incarnation_baseline_revision,
  });
  damage.objectStore("file_changes").put(change);
  await completion;

  assert.equal(marker.incarnation_baseline_revision, 1);
  await assert.rejects(
    workspace.revertChange("baseline-forgery"),
    (error) => error instanceof WorkspaceCorruptionError,
  );
  assert.deepEqual(await workspace.read("/notes.txt"), {
    workspace_revision: 2,
    path_revision: 1,
    content: "after",
  });
  database.close();
});

test("concurrent IndexedDB compare-and-swap writes allow one winner", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-file-cas-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {
    "/notes.txt": "original",
  });
  const filesystem = await provider.create("project-1");

  const results = await Promise.allSettled([
    filesystem.write("/notes.txt", "first", {
      expected_content: "original",
      change: workspaceChangeMetadata("first-change", "write_file"),
    }),
    filesystem.write("/notes.txt", "second", {
      expected_content: "original",
      change: workspaceChangeMetadata("second-change", "write_file"),
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
  const rejection = results.find((result) => result.status === "rejected");
  assert.equal(rejection.reason.code, "conflict");
  const winningRead = await filesystem.read("/notes.txt");
  assert.ok(["first", "second"].includes(winningRead.content));
  assert.equal(winningRead.workspace_revision, 1);
  assert.equal((await filesystem.listChanges()).changes.length, 1);

  const winner = await filesystem.read("/notes.txt");
  await assert.rejects(
    filesystem.remove("/notes.txt", { expected_content: "original" }),
    /changed before it could be removed/,
  );
  const removed = await filesystem.remove("/notes.txt", {
    expected_content: winner.content,
  });
  assert.equal(removed.workspace_revision, 2);
  await assert.rejects(filesystem.read("/notes.txt"), /File not found/);
  database.close();
});

test("IndexedDB listings pair one atomic revision with their contents", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-versioned-list-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {});
  const workspace = await provider.create("project-1");
  const operations = [];

  for (let index = 0; index < 8; index += 1) {
    operations.push(workspace.write(`/file-${index}.txt`, `${index}`));
    operations.push(workspace.list("/"));
  }

  const results = await Promise.all(operations);
  for (const result of results) {
    if (!("entries" in result)) continue;
    assert.equal(result.entries.length, result.workspace_revision);
  }
  assert.equal((await workspace.list("/")).workspace_revision, 8);
  database.close();
});

test("stale IndexedDB handles cannot mutate a deleted or recreated project", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-stale-filesystem-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {});
  const stale = await provider.create("project-1");

  await provider.delete("project-1");
  await assert.rejects(
    stale.write("/ghost.txt", "ghost", {
      change: workspaceChangeMetadata("ghost-change", "write_file"),
    }),
    (error) => error.code === "not_found",
  );
  await assert.rejects(
    stale.list("/"),
    (error) => error.code === "not_found",
  );

  const current = await provider.create("project-1");
  await current.write("/current.txt", "current");
  await assert.rejects(
    stale.write("/ghost.txt", "ghost", {
      change: workspaceChangeMetadata("second-ghost", "write_file"),
    }),
    (error) => error.code === "conflict",
  );
  await assert.rejects(
    stale.remove("/current.txt", { expected_content: "current" }),
    (error) => error.code === "conflict",
  );
  await assert.rejects(
    stale.read("/current.txt"),
    (error) => error.code === "conflict",
  );
  await assert.rejects(
    stale.listChanges(),
    (error) => error.code === "conflict",
  );
  assert.equal((await current.read("/current.txt")).content, "current");
  assert.deepEqual((await current.listChanges()).changes, []);
  database.close();
});

test("IndexedDB v1 project-store migration is persisted exactly once", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-store-migration-${crypto.randomUUID()}`;
  const legacyDatabase = await openLegacyDatabase(factory, databaseName);
  const timestamp = "2026-07-22T00:00:00.000Z";
  const transaction = legacyDatabase.transaction(
    ["meta", "projects", "sessions", "session_documents"],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  transaction.objectStore("meta").put({
    key: "catalog",
    schema_version: 1,
    state_revision: 7,
    active_project_id: "legacy-project",
    active_session_id: "legacy-placeholder",
  });
  transaction.objectStore("projects").put({
    project_id: "legacy-project",
    name: "Legacy project",
    created_at: timestamp,
    updated_at: timestamp,
    last_session_id: "legacy-placeholder",
  });
  transaction.objectStore("sessions").put({
    session_id: "legacy-placeholder",
    project_id: "legacy-project",
    title: "New chat",
    title_is_custom: false,
    created_at: timestamp,
    updated_at: timestamp,
  });
  transaction.objectStore("session_documents").put({
    format_version: 1,
    session_id: "legacy-placeholder",
    project_id: "legacy-project",
    messages: [],
    activities: [],
    agent_messages: [],
  });
  await completion;
  legacyDatabase.close();

  const database = new ResearchBoxDatabase(factory, databaseName);
  const store = new IndexedDbProjectStore(database);
  const expectedState = {
    schema_version: 3,
    state_revision: 8,
    active_project_id: "legacy-project",
    active_session_id: null,
    projects: [
      {
        project_id: "legacy-project",
        name: "Legacy project",
        created_at: timestamp,
        updated_at: timestamp,
        last_session_id: null,
        new_chat_draft: "",
        new_chat_model: createDefaultModelSelection(),
      },
    ],
    sessions: [],
    documents: [],
  };
  assert.deepEqual(await store.load(), expectedState);

  const reopenedDatabase = new ResearchBoxDatabase(factory, databaseName);
  const reopenedStore = new IndexedDbProjectStore(reopenedDatabase);
  assert.deepEqual(await reopenedStore.load(), expectedState);

  const connection = await reopenedDatabase.open();
  const verification = connection.transaction(
    ["meta", "projects", "sessions", "session_documents"],
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  assert.deepEqual(
    await requestValue(verification.objectStore("meta").get("catalog")),
    {
      key: "catalog",
      schema_version: 3,
      state_revision: 8,
      active_project_id: "legacy-project",
      active_session_id: null,
    },
  );
  assert.deepEqual(
    await requestValue(verification.objectStore("projects").getAll()),
    expectedState.projects,
  );
  assert.deepEqual(
    await requestValue(verification.objectStore("sessions").getAll()),
    [],
  );
  assert.deepEqual(
    await requestValue(verification.objectStore("session_documents").getAll()),
    [],
  );
  await verificationComplete;
});

test("IndexedDB v2 migration persists model selections and a v4 timeline exactly once", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-model-migration-${crypto.randomUUID()}`;
  const legacyDatabase = await openLegacyDatabase(factory, databaseName);
  const timestamp = "2026-07-22T00:00:00.000Z";
  const transaction = legacyDatabase.transaction(
    ["meta", "projects", "sessions", "session_documents"],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  transaction.objectStore("meta").put({
    key: "catalog",
    schema_version: 2,
    state_revision: 12,
    active_project_id: "legacy-project",
    active_session_id: "legacy-session",
  });
  transaction.objectStore("projects").put({
    project_id: "legacy-project",
    name: "Legacy project",
    created_at: timestamp,
    updated_at: timestamp,
    last_session_id: "legacy-session",
    new_chat_draft: "new chat draft",
  });
  transaction.objectStore("sessions").put({
    session_id: "legacy-session",
    project_id: "legacy-project",
    title: "Existing chat",
    title_is_custom: false,
    created_at: timestamp,
    updated_at: timestamp,
  });
  transaction
    .objectStore("session_documents")
    .put(createLegacyVersionTwoDocument(timestamp));
  await completion;
  legacyDatabase.close();

  const expectedState = {
    schema_version: 3,
    state_revision: 13,
    active_project_id: "legacy-project",
    active_session_id: "legacy-session",
    projects: [
      {
        project_id: "legacy-project",
        name: "Legacy project",
        created_at: timestamp,
        updated_at: timestamp,
        last_session_id: "legacy-session",
        new_chat_draft: "new chat draft",
        new_chat_model: createDefaultModelSelection(),
      },
    ],
    sessions: [
      {
        session_id: "legacy-session",
        project_id: "legacy-project",
        title: "Existing chat",
        title_is_custom: false,
        created_at: timestamp,
        updated_at: timestamp,
        selected_model: createDefaultModelSelection(),
      },
    ],
    documents: [
      {
        format_version: SESSION_DOCUMENT_FORMAT_VERSION,
        session_id: "legacy-session",
        project_id: "legacy-project",
        input_draft: "session draft",
        timeline: createMigratedTimeline(timestamp),
      },
    ],
  };
  const database = new ResearchBoxDatabase(factory, databaseName);
  const store = new IndexedDbProjectStore(database);
  assert.deepEqual(await store.load(), expectedState);

  const reopenedDatabase = new ResearchBoxDatabase(factory, databaseName);
  const reopenedStore = new IndexedDbProjectStore(reopenedDatabase);
  assert.deepEqual(await reopenedStore.load(), expectedState);

  const connection = await reopenedDatabase.open();
  const verification = connection.transaction(
    ["meta", "projects", "sessions", "session_documents"],
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  assert.deepEqual(
    await requestValue(verification.objectStore("meta").get("catalog")),
    {
      key: "catalog",
      schema_version: 3,
      state_revision: 13,
      active_project_id: "legacy-project",
      active_session_id: "legacy-session",
    },
  );
  assert.deepEqual(
    await requestValue(verification.objectStore("projects").getAll()),
    expectedState.projects,
  );
  assert.deepEqual(
    await requestValue(verification.objectStore("sessions").getAll()),
    expectedState.sessions,
  );
  assert.deepEqual(
    await requestValue(
      verification.objectStore("session_documents").getAll(),
    ),
    expectedState.documents,
  );
  await verificationComplete;
});

test("IndexedDB v3 timeline migration persists file-change tool names exactly once", async () => {
  const factory = new IDBFactory();
  const databaseName =
    `researchbox-timeline-migration-${crypto.randomUUID()}`;
  const legacyDatabase = await openLegacyDatabase(factory, databaseName);
  const timestamp = "2026-07-22T00:00:00.000Z";
  const transaction = legacyDatabase.transaction(
    ["meta", "projects", "sessions", "session_documents"],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  transaction.objectStore("meta").put({
    key: "catalog",
    schema_version: 3,
    state_revision: 20,
    active_project_id: "legacy-project",
    active_session_id: "legacy-session",
  });
  transaction.objectStore("projects").put({
    project_id: "legacy-project",
    name: "Legacy project",
    created_at: timestamp,
    updated_at: timestamp,
    last_session_id: "legacy-session",
    new_chat_draft: "",
    new_chat_model: createDefaultModelSelection(),
  });
  transaction.objectStore("sessions").put({
    session_id: "legacy-session",
    project_id: "legacy-project",
    title: "Existing chat",
    title_is_custom: false,
    created_at: timestamp,
    updated_at: timestamp,
    selected_model: createDefaultModelSelection(),
  });
  transaction.objectStore("session_documents").put({
    format_version: 3,
    session_id: "legacy-session",
    project_id: "legacy-project",
    input_draft: "unfinished prompt",
    timeline: createVersionThreeFileChangeTimeline(timestamp),
  });
  await completion;
  legacyDatabase.close();

  const database = new ResearchBoxDatabase(factory, databaseName);
  const store = new IndexedDbProjectStore(database);
  const migrated = await store.load();
  assert.ok(migrated);
  assert.equal(migrated.state_revision, 21);
  assert.equal(
    migrated.documents[0].format_version,
    SESSION_DOCUMENT_FORMAT_VERSION,
  );
  assert.equal(
    migrated.documents[0].timeline[2].file_change.tool_name,
    "write_file",
  );
  database.close();

  const reopenedDatabase = new ResearchBoxDatabase(factory, databaseName);
  const reopenedStore = new IndexedDbProjectStore(reopenedDatabase);
  assert.deepEqual(await reopenedStore.load(), migrated);

  const connection = await reopenedDatabase.open();
  const verification = connection.transaction(
    ["meta", "session_documents"],
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  assert.equal(
    (
      await requestValue(
        verification.objectStore("meta").get("catalog"),
      )
    ).state_revision,
    21,
  );
  const persistedDocument = await requestValue(
    verification
      .objectStore("session_documents")
      .get("legacy-session"),
  );
  assert.equal(
    persistedDocument.format_version,
    SESSION_DOCUMENT_FORMAT_VERSION,
  );
  assert.equal(
    persistedDocument.timeline[2].file_change.tool_name,
    "write_file",
  );
  await verificationComplete;
  reopenedDatabase.close();
});

test("IndexedDB draft writes validate their target ownership", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-draft-validation-${crypto.randomUUID()}`,
  );
  const store = new IndexedDbProjectStore(database);
  const state = createState();
  await store.save(state, null);

  await assert.rejects(
    store.saveInputDraft({
      project_id: "other-project",
      session_id: "session-1",
      input_draft: "must not persist",
    }),
    /does not belong to project/,
  );
  await assert.rejects(
    store.saveInputDraft({
      project_id: "missing-project",
      session_id: null,
      input_draft: "must not persist",
    }),
    /does not exist/,
  );
  assert.deepEqual(await store.load(), state);
});

test("IndexedDB v1 projects gain filesystem markers during migration", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-migration-${crypto.randomUUID()}`;
  const legacyDatabase = await openLegacyDatabase(factory, databaseName);
  const transaction = legacyDatabase.transaction("projects", "readwrite");
  const completion = transactionComplete(transaction);
  transaction.objectStore("projects").put({
    project_id: "legacy-project",
    name: "Legacy project",
  });
  await completion;
  legacyDatabase.close();

  const database = new ResearchBoxDatabase(factory, databaseName);
  const provider = new IndexedDbWorkspaceBackend(database, {});
  const filesystem = await provider.open("legacy-project");

  assert.deepEqual(await filesystem.list("/"), {
    workspace_revision: 0,
    entries: [],
  });
  database.close();
});

test("IndexedDB v2 filesystem markers gain stable incarnation ids", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-incarnation-migration-${crypto.randomUUID()}`;
  const legacyDatabase = await openVersionTwoDatabase(factory, databaseName);
  const transaction = legacyDatabase.transaction(
    ["projects", "project_filesystems", "files"],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  transaction.objectStore("projects").put({
    project_id: "legacy-project",
    name: "Legacy project",
  });
  transaction.objectStore("project_filesystems").put({
    project_id: "legacy-project",
  });
  transaction.objectStore("files").put({
    project_id: "legacy-project",
    path: "/legacy.txt",
    content: "legacy",
  });
  await completion;
  legacyDatabase.close();

  const database = new ResearchBoxDatabase(factory, databaseName);
  const provider = new IndexedDbWorkspaceBackend(database, {});
  const filesystem = await provider.open("legacy-project");
  assert.deepEqual(await filesystem.read("/legacy.txt"), {
    workspace_revision: 0,
    path_revision: 0,
    content: "legacy",
  });

  const connection = await database.open();
  const verification = connection.transaction(
    "project_filesystems",
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  const marker = await requestValue(
    verification.objectStore("project_filesystems").get("legacy-project"),
  );
  await verificationComplete;
  assert.equal(typeof marker.incarnation_id, "string");
  assert.notEqual(marker.incarnation_id, "");
  assert.equal(marker.workspace_revision, 0);
  assert.equal(marker.last_change_at, null);
  assert.equal(marker.lifecycle_status, "active");
  assert.equal(marker.content_storage, "indexeddb");
  assert.equal(marker.opfs_storage_id, null);
  assert.equal(marker.opfs_migration, null);

  const secondHandle = await provider.open("legacy-project");
  await secondHandle.write("/legacy.txt", "updated", {
    expected_content: "legacy",
  });
  assert.deepEqual(await filesystem.read("/legacy.txt"), {
    workspace_revision: 1,
    path_revision: 1,
    content: "updated",
  });
  database.close();
});

test("IndexedDB v3 workspace markers gain durable revision metadata", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-revision-migration-${crypto.randomUUID()}`;
  const legacyDatabase = await openVersionThreeDatabase(
    factory,
    databaseName,
  );
  const transaction = legacyDatabase.transaction(
    ["project_filesystems", "file_changes"],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  transaction.objectStore("project_filesystems").put({
    project_id: "legacy-project",
    incarnation_id: "stable-incarnation",
  });
  const changes = transaction.objectStore("file_changes");
  changes.put(
    storedWorkspaceChange(
      "legacy-project",
      "later-change",
      "2026-07-24T00:00:00.010Z",
    ),
  );
  changes.put(
    storedWorkspaceChange(
      "legacy-project",
      "earlier-change",
      "2026-07-24T00:00:00.005Z",
    ),
  );
  changes.put(
    storedWorkspaceChange(
      "legacy-project",
      "tied-change",
      "2026-07-24T00:00:00.010Z",
    ),
  );
  changes.put(
    storedWorkspaceChange(
      "legacy-project",
      "invalid-change",
      "not-a-timestamp",
    ),
  );
  await completion;
  legacyDatabase.close();

  const database = new ResearchBoxDatabase(factory, databaseName);
  const provider = new IndexedDbWorkspaceBackend(database, {});
  const workspace = await provider.open("legacy-project");
  assert.deepEqual(await workspace.list("/"), {
    workspace_revision: 4,
    entries: [],
  });
  const legacyChange = await workspace.getChange("later-change");
  assert.equal(
    legacyChange.change.applied_workspace_revision,
    null,
  );
  assert.equal(
    legacyChange.change.reverted_at_workspace_revision,
    null,
  );
  await assert.rejects(
    workspace.revertChange("later-change"),
    (error) => error?.code === "conflict",
  );
  assert.equal((await workspace.list("/")).workspace_revision, 4);

  const connection = await database.open();
  const verification = connection.transaction(
    "project_filesystems",
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  const marker = await requestValue(
    verification.objectStore("project_filesystems").get("legacy-project"),
  );
  await verificationComplete;
  assert.deepEqual(marker, {
    project_id: "legacy-project",
    incarnation_id: "stable-incarnation",
    incarnation_baseline_revision: 4,
    workspace_revision: 4,
    last_change_at: "2026-07-24T00:00:00.010Z",
    lifecycle_status: "active",
    content_storage: "indexeddb",
    opfs_storage_id: null,
    opfs_migration: null,
  });

  database.close();
  const reopenedDatabase = new ResearchBoxDatabase(factory, databaseName);
  const reopened = await new IndexedDbWorkspaceBackend(
    reopenedDatabase,
    {},
  ).open("legacy-project");
  assert.equal((await reopened.list("/")).workspace_revision, 4);
  reopenedDatabase.close();
});

test("IndexedDB v4 workspace markers gain explicit content storage state", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-storage-migration-${crypto.randomUUID()}`;
  const legacyDatabase = await openVersionFourDatabase(
    factory,
    databaseName,
  );
  const transaction = legacyDatabase.transaction(
    ["project_filesystems", "files"],
    "readwrite",
  );
  const completion = transactionComplete(transaction);
  transaction.objectStore("project_filesystems").put({
    project_id: "active-project",
    incarnation_id: "active-incarnation",
    workspace_revision: 2,
    last_change_at: null,
    lifecycle_status: "active",
  });
  transaction.objectStore("project_filesystems").put({
    project_id: "deleted-project",
    incarnation_id: "deleted-incarnation",
    workspace_revision: 7,
    last_change_at: null,
    lifecycle_status: "deleted",
  });
  transaction.objectStore("files").put({
    project_id: "active-project",
    path: "/legacy.txt",
    content: "legacy",
  });
  await completion;
  legacyDatabase.close();

  const database = new ResearchBoxDatabase(factory, databaseName);
  const connection = await database.open();
  assert.equal(connection.version, 9);
  assert.equal(connection.objectStoreNames.contains("opfs_files"), true);
  assert.equal(
    connection.objectStoreNames.contains("file_change_quarantines"),
    true,
  );
  assert.equal(
    connection.objectStoreNames.contains("file_path_tombstones"),
    true,
  );
  const verification = connection.transaction(
    [
      "project_filesystems",
      "opfs_files",
      "file_change_quarantines",
      "file_path_tombstones",
    ],
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  assert.equal(
    verification
      .objectStore("opfs_files")
      .indexNames.contains("by_project"),
    true,
  );
  assert.deepEqual(
    [...verification
      .objectStore("file_change_quarantines")
      .indexNames],
    ["by_change", "by_project", "by_workspace"],
  );
  assert.deepEqual(
    [...verification
      .objectStore("file_path_tombstones")
      .indexNames],
    ["by_project"],
  );
  assert.deepEqual(
    await requestValue(
      verification.objectStore("project_filesystems").get("active-project"),
    ),
    {
      project_id: "active-project",
      incarnation_id: "active-incarnation",
      incarnation_baseline_revision: 2,
      workspace_revision: 2,
      last_change_at: null,
      lifecycle_status: "active",
      content_storage: "indexeddb",
      opfs_storage_id: null,
      opfs_migration: null,
    },
  );
  assert.deepEqual(
    await requestValue(
      verification.objectStore("project_filesystems").get("deleted-project"),
    ),
    {
      project_id: "deleted-project",
      incarnation_id: "deleted-incarnation",
      incarnation_baseline_revision: 7,
      workspace_revision: 7,
      last_change_at: null,
      lifecycle_status: "deleted",
      content_storage: "none",
      opfs_storage_id: null,
      opfs_migration: null,
    },
  );
  assert.deepEqual(
    await requestValue(verification.objectStore("opfs_files").getAll()),
    [],
  );
  await verificationComplete;

  const provider = new IndexedDbWorkspaceBackend(database, {});
  assert.equal(
    (await (await provider.open("active-project")).read("/legacy.txt")).content,
    "legacy",
  );
  await assert.rejects(
    provider.open("deleted-project"),
    /does not exist/,
  );
  database.close();
});

test("legacy IndexedDB backend rejects OPFS ownership and clears OPFS metadata on delete", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-ownership-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {
    "/inline.txt": "inline",
  });
  const workspace = await provider.create("project-1");
  const connection = await database.open();
  const markOpfs = connection.transaction(
    ["project_filesystems", "opfs_files"],
    "readwrite",
  );
  const markOpfsComplete = transactionComplete(markOpfs);
  const marker = await requestValue(
    markOpfs.objectStore("project_filesystems").get("project-1"),
  );
  markOpfs.objectStore("project_filesystems").put({
    ...marker,
    content_storage: "opfs",
    opfs_storage_id: "storage-1",
    opfs_migration: null,
  });
  markOpfs.objectStore("opfs_files").put({
    project_id: "project-1",
    path: "/inline.txt",
    incarnation_id: marker.incarnation_id,
    storage_id: "storage-1",
    content_id: "content-1",
    byte_size: 6,
    migration_id: null,
  });
  await markOpfsComplete;

  for (const operation of [
    () => workspace.list("/"),
    () => provider.open("project-1"),
    () => provider.delete("project-1"),
  ]) {
    await assert.rejects(
      operation(),
      (error) =>
        error.name === "ProjectFileSystemMetadataError" &&
        /stored in OPFS/.test(error.message),
    );
  }

  const verifyRejectedDelete = connection.transaction(
    ["project_filesystems", "files", "opfs_files"],
    "readonly",
  );
  const verifyRejectedDeleteComplete = transactionComplete(
    verifyRejectedDelete,
  );
  assert.equal(
    (
      await requestValue(
        verifyRejectedDelete.objectStore("files").getAll(),
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await requestValue(
        verifyRejectedDelete.objectStore("opfs_files").getAll(),
      )
    ).length,
    1,
  );
  await verifyRejectedDeleteComplete;

  const returnToIndexedDb = connection.transaction(
    "project_filesystems",
    "readwrite",
  );
  const returnToIndexedDbComplete = transactionComplete(returnToIndexedDb);
  returnToIndexedDb.objectStore("project_filesystems").put({
    ...marker,
    content_storage: "indexeddb",
    opfs_storage_id: null,
    opfs_migration: null,
  });
  await returnToIndexedDbComplete;
  await provider.delete("project-1");

  const verification = connection.transaction(
    ["project_filesystems", "files", "opfs_files"],
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  assert.deepEqual(
    await requestValue(
      verification.objectStore("project_filesystems").get("project-1"),
    ),
    {
      ...marker,
      workspace_revision: 1,
      lifecycle_status: "deleted",
      content_storage: "none",
      opfs_storage_id: null,
      opfs_migration: null,
    },
  );
  assert.deepEqual(
    await requestValue(verification.objectStore("files").getAll()),
    [],
  );
  assert.deepEqual(
    await requestValue(verification.objectStore("opfs_files").getAll()),
    [],
  );
  await verificationComplete;
  database.close();
});

test("current IndexedDB markers lazily repair revision metadata", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-revision-repair-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {});
  const originalHandle = await provider.create("project-1");
  const write = await originalHandle.write("/notes.txt", "persisted", {
    change: workspaceChangeMetadata("repair-change", "write_file"),
  });
  const expectedTimestamp = write.result.change.created_at;

  const connection = await database.open();
  const readMarker = connection.transaction(
    "project_filesystems",
    "readonly",
  );
  const readMarkerComplete = transactionComplete(readMarker);
  const originalMarker = await requestValue(
    readMarker.objectStore("project_filesystems").get("project-1"),
  );
  await readMarkerComplete;

  const damage = connection.transaction("project_filesystems", "readwrite");
  const damageComplete = transactionComplete(damage);
  damage.objectStore("project_filesystems").put({
    project_id: "project-1",
    incarnation_id: originalMarker.incarnation_id,
  });
  await damageComplete;

  const repairedHandle = await provider.open("project-1");
  assert.deepEqual(await repairedHandle.read("/notes.txt"), {
    workspace_revision: 1,
    path_revision: 1,
    content: "persisted",
  });
  assert.deepEqual(await originalHandle.read("/notes.txt"), {
    workspace_revision: 1,
    path_revision: 1,
    content: "persisted",
  });

  const verification = connection.transaction(
    "project_filesystems",
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  const repairedMarker = await requestValue(
    verification.objectStore("project_filesystems").get("project-1"),
  );
  await verificationComplete;
  assert.deepEqual(repairedMarker, {
    project_id: "project-1",
    incarnation_id: originalMarker.incarnation_id,
    incarnation_baseline_revision: 0,
    workspace_revision: 1,
    last_change_at: expectedTimestamp,
    lifecycle_status: "active",
    content_storage: "indexeddb",
    opfs_storage_id: null,
    opfs_migration: null,
  });
  database.close();
});

test("IndexedDB marker repair preserves a consumed receipt revision", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-revert-revision-repair-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {
    "/notes.txt": "before",
  });
  const originalHandle = await provider.create("project-1");
  await originalHandle.write("/notes.txt", "after", {
    change: workspaceChangeMetadata(
      "repaired-revert",
      "write_file",
    ),
  });
  await originalHandle.revertChange("repaired-revert");

  const connection = await database.open();
  const readMarker = connection.transaction(
    "project_filesystems",
    "readonly",
  );
  const readMarkerComplete = transactionComplete(readMarker);
  const originalMarker = await requestValue(
    readMarker.objectStore("project_filesystems").get("project-1"),
  );
  await readMarkerComplete;

  const damage = connection.transaction(
    "project_filesystems",
    "readwrite",
  );
  const damageComplete = transactionComplete(damage);
  damage.objectStore("project_filesystems").put({
    project_id: "project-1",
    incarnation_id: originalMarker.incarnation_id,
  });
  await damageComplete;

  const repaired = await provider.open("project-1");
  assert.deepEqual(await repaired.read("/notes.txt"), {
    workspace_revision: 2,
    path_revision: 2,
    content: "before",
  });
  const receipt = await repaired.getChange("repaired-revert");
  assert.equal(receipt.workspace_revision, 2);
  assert.equal(
    receipt.change.reverted_at_workspace_revision,
    2,
  );
  const replay = await repaired.revertChange("repaired-revert");
  assert.equal(replay.workspace_revision, 2);
  assert.equal(replay.revert_outcome, "already_reverted");
  database.close();
});

test("deleted IndexedDB markers without a revision fail closed", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-deleted-marker-repair-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {});
  await provider.create("project-1");
  await provider.delete("project-1");

  const connection = await database.open();
  const readMarker = connection.transaction(
    "project_filesystems",
    "readonly",
  );
  const readMarkerComplete = transactionComplete(readMarker);
  const tombstone = await requestValue(
    readMarker.objectStore("project_filesystems").get("project-1"),
  );
  await readMarkerComplete;

  const damage = connection.transaction("project_filesystems", "readwrite");
  const damageComplete = transactionComplete(damage);
  damage.objectStore("project_filesystems").put({
    project_id: "project-1",
    incarnation_id: tombstone.incarnation_id,
    lifecycle_status: "deleted",
  });
  await damageComplete;

  for (const operation of [
    () => provider.open("project-1"),
    () => provider.create("project-1"),
    () => provider.delete("project-1"),
  ]) {
    await assert.rejects(
      operation(),
      (error) =>
        error.name === "ProjectFileSystemMetadataError" &&
        /no recoverable revision/.test(error.message),
    );
  }

  const verifyDamage = connection.transaction(
    "project_filesystems",
    "readonly",
  );
  const verifyDamageComplete = transactionComplete(verifyDamage);
  const damagedTombstone = await requestValue(
    verifyDamage.objectStore("project_filesystems").get("project-1"),
  );
  await verifyDamageComplete;
  assert.deepEqual(damagedTombstone, {
    project_id: "project-1",
    incarnation_id: tombstone.incarnation_id,
    lifecycle_status: "deleted",
  });
  database.close();
});

test("current IndexedDB markers missing incarnation ids are repaired lazily", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-incarnation-repair-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {});
  const oldHandle = await provider.create("project-1");
  await oldHandle.write("/notes.txt", "persisted");

  const connection = await database.open();
  const damage = connection.transaction("project_filesystems", "readwrite");
  const damageComplete = transactionComplete(damage);
  damage.objectStore("project_filesystems").put({ project_id: "project-1" });
  await damageComplete;

  const repairedHandle = await provider.open("project-1");
  assert.deepEqual(await repairedHandle.read("/notes.txt"), {
    workspace_revision: 0,
    path_revision: 1,
    content: "persisted",
  });
  await assert.rejects(
    oldHandle.read("/notes.txt"),
    (error) => error.code === "conflict",
  );

  const verification = connection.transaction(
    "project_filesystems",
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  const marker = await requestValue(
    verification.objectStore("project_filesystems").get("project-1"),
  );
  await verificationComplete;
  assert.equal(typeof marker.incarnation_id, "string");
  assert.notEqual(marker.incarnation_id, "");
  assert.equal(marker.workspace_revision, 0);
  assert.equal(marker.last_change_at, null);
  assert.equal(marker.lifecycle_status, "active");
  assert.equal(marker.content_storage, "indexeddb");
  assert.equal(marker.opfs_storage_id, null);
  assert.equal(marker.opfs_migration, null);
  database.close();
});

test("a blocked IndexedDB upgrade can be retried without leaking its late connection", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-blocked-${crypto.randomUUID()}`;
  const legacyDatabase = await openLegacyDatabase(factory, databaseName);
  const database = new ResearchBoxDatabase(factory, databaseName);

  await assert.rejects(
    database.open(),
    /upgrade is blocked/,
  );

  legacyDatabase.close();
  const connection = await database.open();
  assert.equal(connection.version, 9);

  database.close();
  await Promise.resolve();
  await deleteDatabase(factory, databaseName);
});

test("IndexedDB v7 databases gain receipt quarantine and path tombstone storage", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-v7-quarantine-${crypto.randomUUID()}`;
  const legacyDatabase = await openVersionSevenWithoutQuarantineDatabase(
    factory,
    databaseName,
  );
  legacyDatabase.close();

  const database = new ResearchBoxDatabase(factory, databaseName);
  const connection = await database.open();
  assert.equal(connection.version, 9);
  assert.equal(
    connection.objectStoreNames.contains("file_change_quarantines"),
    true,
  );
  assert.equal(
    connection.objectStoreNames.contains("file_path_tombstones"),
    true,
  );
  const verification = connection.transaction(
    ["file_change_quarantines", "file_path_tombstones"],
    "readonly",
  );
  const verificationComplete = transactionComplete(verification);
  const quarantineStore = verification.objectStore(
    "file_change_quarantines",
  );
  assert.equal(quarantineStore.indexNames.contains("by_project"), true);
  assert.equal(quarantineStore.indexNames.contains("by_workspace"), true);
  assert.equal(quarantineStore.indexNames.contains("by_change"), true);
  assert.equal(
    verification
      .objectStore("file_path_tombstones")
      .indexNames
      .contains("by_project"),
    true,
  );
  await verificationComplete;
  database.close();
});

test("closing a pending blocked open consumes its rejection", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-close-blocked-${crypto.randomUUID()}`;
  const legacyDatabase = await openLegacyDatabase(factory, databaseName);
  const database = new ResearchBoxDatabase(factory, databaseName);
  const opening = database.open();

  database.close();
  await assert.rejects(opening, /upgrade is blocked/);

  legacyDatabase.close();
  await deleteDatabase(factory, databaseName);
});

test("concurrent IndexedDB writes preserve file and directory path invariants", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-write-race-${crypto.randomUUID()}`,
  );
  const provider = new IndexedDbWorkspaceBackend(database, {});
  const filesystem = await provider.create("project-1");

  const results = await Promise.allSettled([
    filesystem.write("/a", "root file"),
    filesystem.write("/a/b", "nested file"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );

  if (results[0].status === "fulfilled") {
    assert.equal((await filesystem.read("/a")).content, "root file");
    await assert.rejects(filesystem.read("/a/b"), /File not found/);
  } else {
    await assert.rejects(filesystem.read("/a"), /Path is a directory/);
    assert.equal((await filesystem.read("/a/b")).content, "nested file");
  }

  database.close();
});

test("IndexedDB store rejects a stale writer revision", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-conflict-${crypto.randomUUID()}`,
  );
  const store = new IndexedDbProjectStore(database);
  await store.save(createState(), null);
  const stale = createState();
  await assert.rejects(store.save(stale, 0), /changed by another writer/);
});

test("concurrent IndexedDB project mutations rebase without lost rows", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-project-mutate-${crypto.randomUUID()}`;
  const firstDatabase = new ResearchBoxDatabase(factory, databaseName);
  const secondDatabase = new ResearchBoxDatabase(factory, databaseName);
  const firstStore = new IndexedDbProjectStore(firstDatabase);
  const secondStore = new IndexedDbProjectStore(secondDatabase);
  await firstStore.save(createState(), null);

  const [projectCommit, sessionCommit] = await Promise.all([
    firstStore.mutate((draft) => {
      draft.projects[0].name = "Renamed workspace";
      return draft;
    }),
    secondStore.mutate((draft) => {
      draft.sessions[0].title = "Renamed chat";
      draft.sessions[0].title_is_custom = true;
      return draft;
    }),
  ]);

  assert.deepEqual(
    [projectCommit.state.state_revision, sessionCommit.state.state_revision]
      .sort((left, right) => left - right),
    [2, 3],
  );
  const persisted = await firstStore.load();
  assert.equal(persisted.state_revision, 3);
  assert.equal(persisted.projects[0].name, "Renamed workspace");
  assert.equal(persisted.sessions[0].title, "Renamed chat");

  firstDatabase.close();
  secondDatabase.close();
});

test("IndexedDB draft and catalog mutations preserve both writers", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-draft-mutate-${crypto.randomUUID()}`;
  const firstDatabase = new ResearchBoxDatabase(factory, databaseName);
  const secondDatabase = new ResearchBoxDatabase(factory, databaseName);
  const firstStore = new IndexedDbProjectStore(firstDatabase);
  const secondStore = new IndexedDbProjectStore(secondDatabase);
  await firstStore.save(createState(), null);

  await Promise.all([
    firstStore.saveInputDraft({
      project_id: "project-1",
      session_id: "session-1",
      input_draft: "Concurrent draft",
    }),
    secondStore.mutate((draft) => {
      draft.projects[0].name = "Concurrent rename";
      return draft;
    }),
  ]);

  const persisted = await firstStore.load();
  assert.equal(persisted.state_revision, 3);
  assert.equal(persisted.projects[0].name, "Concurrent rename");
  assert.equal(persisted.documents[0].input_draft, "Concurrent draft");

  firstDatabase.close();
  secondDatabase.close();
});

test("IndexedDB project stores publish local and injected-channel changes", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-project-changes-${crypto.randomUUID()}`;
  const firstDatabase = new ResearchBoxDatabase(factory, databaseName);
  const secondDatabase = new ResearchBoxDatabase(factory, databaseName);
  const channelHub = createProjectStoreChangeChannelHub();
  const firstStore = new IndexedDbProjectStore(firstDatabase, {
    change_channel: channelHub.open(),
    source_id: "first-store",
  });
  const secondStore = new IndexedDbProjectStore(secondDatabase, {
    change_channel: channelHub.open(),
    source_id: "second-store",
  });
  const firstChanges = [];
  const secondChanges = [];
  firstStore.subscribe((change) => firstChanges.push(change));
  const unsubscribeSecond = secondStore.subscribe((change) =>
    secondChanges.push(change),
  );

  await firstStore.save(createState(), null);
  await secondStore.mutate(() => null);
  await assert.rejects(
    secondStore.save(createState(), null),
    /changed by another writer/,
  );
  await secondStore.saveInputDraft({
    project_id: "project-1",
    session_id: null,
    input_draft: "Broadcast draft",
  });

  assert.deepEqual(firstChanges, [
    { source_id: "first-store", state_revision: 1 },
    { source_id: "second-store", state_revision: 2 },
  ]);
  assert.deepEqual(secondChanges, [
    { source_id: "first-store", state_revision: 1 },
    { source_id: "second-store", state_revision: 2 },
  ]);

  unsubscribeSecond();
  await firstStore.mutate((draft) => {
    draft.projects[0].name = "Only first store observes locally";
    return draft;
  });
  assert.deepEqual(
    firstChanges.map((change) => change.state_revision),
    [1, 2, 3],
  );
  assert.equal(secondChanges.length, 2);

  firstStore.close();
  secondStore.close();
  assert.equal(channelHub.size, 0);
  firstDatabase.close();
  secondDatabase.close();
});

function createState() {
  const timestamp = "2026-07-22T00:00:00.000Z";
  return {
    schema_version: 3,
    state_revision: 1,
    active_project_id: "project-1",
    active_session_id: "session-1",
    projects: [
      {
        project_id: "project-1",
        name: "Local workspace",
        created_at: timestamp,
        updated_at: timestamp,
        last_session_id: "session-1",
        new_chat_draft: "",
        new_chat_model: createDefaultModelSelection(),
      },
    ],
    sessions: [
      {
        session_id: "session-1",
        project_id: "project-1",
        title: "First chat",
        title_is_custom: false,
        created_at: timestamp,
        updated_at: timestamp,
        selected_model: createDefaultModelSelection(),
      },
    ],
    documents: [
      {
        format_version: SESSION_DOCUMENT_FORMAT_VERSION,
        session_id: "session-1",
        project_id: "project-1",
        input_draft: "",
        timeline: [],
      },
    ],
  };
}

function createProjectStoreChangeChannelHub() {
  const endpoints = new Set();
  return {
    get size() {
      return endpoints.size;
    },
    open() {
      const listeners = new Set();
      const endpoint = {
        postMessage(change) {
          for (const peer of endpoints) {
            if (peer === endpoint) continue;
            peer.deliver(structuredClone(change));
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close() {
          listeners.clear();
          endpoints.delete(endpoint);
        },
        deliver(change) {
          for (const listener of listeners) listener(change);
        },
      };
      endpoints.add(endpoint);
      return endpoint;
    },
  };
}

function createLegacyVersionTwoDocument(timestamp) {
  return {
    format_version: 2,
    session_id: "legacy-session",
    project_id: "legacy-project",
    input_draft: "session draft",
    messages: [
      {
        id: "legacy-user",
        role: "user",
        content: "Remember this session",
        created_at: timestamp,
        status: "complete",
      },
      {
        id: "legacy-assistant",
        role: "assistant",
        content: "Remembered.",
        created_at: timestamp,
        status: "complete",
      },
    ],
    activities: [],
    agent_messages: [],
  };
}

function createMigratedTimeline(timestamp) {
  const runId = "legacy:legacy-session:run:0";
  return [
    {
      type: "user_message",
      entry_id: "legacy-user",
      run_id: runId,
      created_at: timestamp,
      content: "Remember this session",
    },
    {
      type: "assistant_message",
      entry_id: "legacy-assistant",
      run_id: runId,
      created_at: timestamp,
      status: "complete",
      api: "legacy",
      provider: "legacy",
      model: "legacy",
      usage: emptyUsage(),
      stop_reason: "stop",
      blocks: [
        {
          type: "assistant_text",
          block_id:
            "legacy:legacy-session:fallback:entry:1:block:text",
          text: "Remembered.",
        },
      ],
    },
  ];
}

function createVersionThreeFileChangeTimeline(timestamp) {
  const runId = "legacy:legacy-session:run:0";
  return [
    {
      type: "user_message",
      entry_id: "legacy-user",
      run_id: runId,
      created_at: timestamp,
      content: "Create a note",
    },
    {
      type: "assistant_message",
      entry_id: "legacy-assistant",
      run_id: runId,
      created_at: timestamp,
      status: "complete",
      api: "mock",
      provider: "researchbox",
      model: "researchbox-mock",
      usage: emptyUsage(),
      stop_reason: "tool_use",
      blocks: [
        {
          type: "tool_call",
          block_id: "legacy-tool-block",
          tool_call_id: "legacy-write",
          tool_name: "write_file",
          arguments: {
            path: "/notes/note.md",
            content: "# Note",
          },
        },
      ],
    },
    {
      type: "tool_result",
      entry_id: "legacy-result",
      run_id: runId,
      created_at: timestamp,
      tool_call_block_id: "legacy-tool-block",
      tool_call_id: "legacy-write",
      tool_name: "write_file",
      content: '{"path":"/notes/note.md"}',
      is_error: false,
      summary: "Created · +1 −0",
      file_change: {
        change_id: "legacy-change",
        tool_call_id: "legacy-write",
        path: "/notes/note.md",
        change_kind: "created",
        additions: 1,
        deletions: 0,
        byte_size: 6,
      },
    },
  ];
}

function createDefaultModelSelection() {
  return {
    provider_id: "researchbox",
    model_id: "researchbox-mock",
  };
}

function workspaceChangeMetadata(changeId, toolName) {
  return {
    change_id: changeId,
    session_id: "session-1",
    tool_call_block_id: `block-${changeId}`,
    assistant_message_index: 1,
    tool_call_id: `tool-${changeId}`,
    tool_name: toolName,
    created_at: `2026-07-23T00:00:00.${changeId.length
      .toString()
      .padStart(3, "0")}Z`,
  };
}

function storedWorkspaceChange(projectId, changeId, createdAt) {
  return {
    project_id: projectId,
    ...workspaceChangeMetadata(changeId, "write_file"),
    created_at: createdAt,
    path: `/${changeId}.txt`,
    change_kind: "created",
    before_content: null,
    after_content: changeId,
    additions: 1,
    deletions: 0,
    byte_size: changeId.length,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    total_tokens: 0,
    cost: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total: 0,
    },
  };
}

function failNextMarkerPublication(database) {
  const originalOpen = database.open.bind(database);
  let failurePending = true;
  database.open = async () => {
    const connection = await originalOpen();
    return new Proxy(connection, {
      get(target, property) {
        if (property !== "transaction") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function"
            ? value.bind(target)
            : value;
        }
        return (storeNames, mode) => {
          const transaction = target.transaction(storeNames, mode);
          if (
            !failurePending ||
            mode !== "readwrite" ||
            !includesStore(storeNames, "project_filesystems")
          ) {
            return transaction;
          }
          return new Proxy(transaction, {
            get(transactionTarget, transactionProperty) {
              if (transactionProperty !== "objectStore") {
                const value = Reflect.get(
                  transactionTarget,
                  transactionProperty,
                  transactionTarget,
                );
                return typeof value === "function"
                  ? value.bind(transactionTarget)
                  : value;
              }
              return (storeName) => {
                const store = transactionTarget.objectStore(storeName);
                if (storeName !== "project_filesystems") return store;
                return new Proxy(store, {
                  get(storeTarget, storeProperty) {
                    if (storeProperty === "put") {
                      return () => {
                        failurePending = false;
                        throw new Error(
                          "injected marker publication failure",
                        );
                      };
                    }
                    const value = Reflect.get(
                      storeTarget,
                      storeProperty,
                      storeTarget,
                    );
                    return typeof value === "function"
                      ? value.bind(storeTarget)
                      : value;
                  },
                });
              };
            },
            set(transactionTarget, property, value) {
              return Reflect.set(
                transactionTarget,
                property,
                value,
                transactionTarget,
              );
            },
          });
        };
      },
    });
  };
  return () => {
    database.open = originalOpen;
  };
}

function includesStore(storeNames, expected) {
  return typeof storeNames === "string"
    ? storeNames === expected
    : [...storeNames].includes(expected);
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openLegacyDatabase(factory, databaseName) {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("meta", { keyPath: "key" });
      database.createObjectStore("projects", { keyPath: "project_id" });
      const sessions = database.createObjectStore("sessions", {
        keyPath: "session_id",
      });
      sessions.createIndex("by_project", "project_id", { unique: false });
      database.createObjectStore("session_documents", {
        keyPath: "session_id",
      });
      const files = database.createObjectStore("files", {
        keyPath: ["project_id", "path"],
      });
      files.createIndex("by_project", "project_id", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openVersionTwoDatabase(factory, databaseName) {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("meta", { keyPath: "key" });
      database.createObjectStore("projects", { keyPath: "project_id" });
      const sessions = database.createObjectStore("sessions", {
        keyPath: "session_id",
      });
      sessions.createIndex("by_project", "project_id", { unique: false });
      database.createObjectStore("session_documents", {
        keyPath: "session_id",
      });
      database.createObjectStore("project_filesystems", {
        keyPath: "project_id",
      });
      const files = database.createObjectStore("files", {
        keyPath: ["project_id", "path"],
      });
      files.createIndex("by_project", "project_id", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openVersionThreeDatabase(factory, databaseName) {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("meta", { keyPath: "key" });
      database.createObjectStore("projects", { keyPath: "project_id" });
      const sessions = database.createObjectStore("sessions", {
        keyPath: "session_id",
      });
      sessions.createIndex("by_project", "project_id", { unique: false });
      database.createObjectStore("session_documents", {
        keyPath: "session_id",
      });
      database.createObjectStore("project_filesystems", {
        keyPath: "project_id",
      });
      const files = database.createObjectStore("files", {
        keyPath: ["project_id", "path"],
      });
      files.createIndex("by_project", "project_id", { unique: false });
      const changes = database.createObjectStore("file_changes", {
        keyPath: ["project_id", "change_id"],
      });
      changes.createIndex("by_project", "project_id", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openVersionFourDatabase(factory, databaseName) {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 4);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("meta", { keyPath: "key" });
      database.createObjectStore("projects", { keyPath: "project_id" });
      const sessions = database.createObjectStore("sessions", {
        keyPath: "session_id",
      });
      sessions.createIndex("by_project", "project_id", { unique: false });
      database.createObjectStore("session_documents", {
        keyPath: "session_id",
      });
      database.createObjectStore("project_filesystems", {
        keyPath: "project_id",
      });
      const files = database.createObjectStore("files", {
        keyPath: ["project_id", "path"],
      });
      files.createIndex("by_project", "project_id", { unique: false });
      const changes = database.createObjectStore("file_changes", {
        keyPath: ["project_id", "change_id"],
      });
      changes.createIndex("by_project", "project_id", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openVersionSevenWithoutQuarantineDatabase(factory, databaseName) {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 7);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("meta", { keyPath: "key" });
      database.createObjectStore("projects", { keyPath: "project_id" });
      const sessions = database.createObjectStore("sessions", {
        keyPath: "session_id",
      });
      sessions.createIndex("by_project", "project_id", { unique: false });
      database.createObjectStore("session_documents", {
        keyPath: "session_id",
      });
      database.createObjectStore("project_filesystems", {
        keyPath: "project_id",
      });
      const files = database.createObjectStore("files", {
        keyPath: ["project_id", "path"],
      });
      files.createIndex("by_project", "project_id", { unique: false });
      const changes = database.createObjectStore("file_changes", {
        keyPath: ["project_id", "change_id"],
      });
      changes.createIndex("by_project", "project_id", { unique: false });
      const opfsFiles = database.createObjectStore("opfs_files", {
        keyPath: ["project_id", "path"],
      });
      opfsFiles.createIndex("by_project", "project_id", {
        unique: false,
      });
      opfsFiles.createIndex("by_storage", "storage_id", {
        unique: false,
      });
      opfsFiles.createIndex("by_content", "content_id", {
        unique: false,
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function deleteDatabase(factory, databaseName) {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      reject(new Error("IndexedDB deletion remained blocked."));
    };
  });
}
