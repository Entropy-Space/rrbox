import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  ResearchBoxCore,
} from "@researchbox/agent-core";
import { PiSessionRuntimeProvider } from "@researchbox/runtime-legacy";
import { SESSION_DOCUMENT_FORMAT_VERSION } from "@researchbox/project-store";
import { createCommand } from "@researchbox/protocol";
import {
  defineDurableWorkspaceBackendConformance,
  defineWorkspaceBackendConformance,
} from "@researchbox/vfs-testkit";
import { WorkspaceCorruptionError } from "@researchbox/vfs";
import { capturePortableWorkspace } from "@researchbox/workspace-archive/snapshot";
import {
  BrowserWorkspaceBackend,
  databaseStores,
  IndexedDbWorkspaceBackend,
  IndexedDbProjectStore,
  ResearchBoxDatabase,
} from "../src/index.ts";
import { OpfsWorkspaceBackend } from "../src/opfs-workspace-backend.ts";

const opfsConformance = {
  name: "OPFS workspace backend",
  async create_backend({ seed_files }) {
    const factory = new IDBFactory();
    const databaseName = `researchbox-opfs-${crypto.randomUUID()}`;
    const objects = new MemoryWorkspaceObjectStore();
    let database = new ResearchBoxDatabase(factory, databaseName);
    let backend = new OpfsWorkspaceBackend(
      database,
      objects,
      seed_files,
    );

    return {
      backend,
      async reopen() {
        database.close();
        database = new ResearchBoxDatabase(factory, databaseName);
        backend = new OpfsWorkspaceBackend(database, objects, {});
        return backend;
      },
      close() {
        database.close();
      },
    };
  },
};

defineWorkspaceBackendConformance(opfsConformance);
defineDurableWorkspaceBackendConformance(opfsConformance);

test("independent OPFS backends atomically consume one revert receipt", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-concurrent-revert-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const runUncoordinated = (operation) => operation();
  const firstBackend = new OpfsWorkspaceBackend(
    database,
    objects,
    { "/notes.txt": "before" },
    runUncoordinated,
  );
  const first = await firstBackend.create("project-1");
  await first.write("/notes.txt", "after", {
    change: changeMetadata(
      "concurrent-revert",
      "2026-07-24T00:00:00.000Z",
    ),
  });
  const second = await new OpfsWorkspaceBackend(
    database,
    objects,
    {},
    runUncoordinated,
  ).open("project-1");

  const outcomes = await Promise.all([
    first.revertChange("concurrent-revert"),
    second.revertChange("concurrent-revert"),
  ]);
  assert.deepEqual(
    outcomes.map((result) => result.revert_outcome).sort(),
    ["already_reverted", "applied"],
  );
  assert.ok(
    outcomes.every(
      (result) =>
        result.workspace_revision === 2 &&
        result.reverted_at_workspace_revision === 2,
    ),
  );
  assert.deepEqual(await first.read("/notes.txt"), {
    workspace_revision: 2,
    path_revision: 2,
    content: "before",
  });
  database.close();
});

test("OPFS journaled removal rolls back when marker publication fails", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-remove-failure-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(
    database,
    objects,
    { "/notes.txt": "before" },
  );
  const workspace = await backend.create("project-1");
  const restoreOpen = failNextMarkerPublication(database);

  try {
    await assert.rejects(
      workspace.remove("/notes.txt", {
        expected_content: "before",
        change: {
          ...changeMetadata(
            "failed-remove",
            "2026-07-24T00:00:00.000Z",
          ),
          tool_name: "remove_file",
        },
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
  assert.equal(objects.write_attempts, 1);
  database.close();
});

test("OPFS preserves a receipt with a redundant malformed assistant index", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-legacy-index-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(
    database,
    objects,
    { "/notes.txt": "before" },
  );
  const workspace = await backend.create("project-1");
  await workspace.write("/notes.txt", "after", {
    change: changeMetadata(
      "legacy-index",
      "2026-07-24T00:00:00.000Z",
    ),
  });

  const connection = await database.open();
  const damage = connection.transaction("file_changes", "readwrite");
  const damageComplete = transactionComplete(damage);
  const store = damage.objectStore("file_changes");
  const stored = await requestValue(
    store.get(["project-1", "legacy-index"]),
  );
  stored.assistant_message_index = "legacy";
  store.put(stored);
  await damageComplete;

  const journal = await workspace.listChanges();
  assert.equal(journal.quarantine_status, undefined);
  assert.equal(journal.changes[0].assistant_message_index, null);
  assert.equal(
    (await workspace.getChange("legacy-index")).change
      .assistant_message_index,
    null,
  );
  assert.equal(
    (await workspace.revertChange("legacy-index")).revert_outcome,
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
        .get(["project-1", "legacy-index"]),
    ),
    requestValue(
      verification
        .objectStore("file_change_quarantines")
        .index("by_project")
        .getAll("project-1"),
    ),
  ]);
  await verificationComplete;
  assert.equal(persisted.assistant_message_index, "legacy");
  assert.equal(quarantines.length, 0);
  database.close();
});

test("OPFS project replacement clears receipt quarantine markers", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-quarantine-lifecycle-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  const workspace = await backend.create("project-1");
  await workspace.write("/invalid.txt", "after", {
    change: changeMetadata(
      "invalid-identity",
      "2026-07-24T00:00:00.000Z",
    ),
  });

  const connection = await database.open();
  const damage = connection.transaction("file_changes", "readwrite");
  const damageComplete = transactionComplete(damage);
  const store = damage.objectStore("file_changes");
  const stored = await requestValue(
    store.get(["project-1", "invalid-identity"]),
  );
  delete stored.tool_call_block_id;
  stored.assistant_message_index = -1;
  store.put(stored);
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

test("OPFS reverts fail before staging corrupt persisted state", async (t) => {
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
      name: "future manifest path revision",
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
        `researchbox-opfs-corrupt-revert-${crypto.randomUUID()}`,
      );
      const objects = new MemoryWorkspaceObjectStore();
      const backend = new OpfsWorkspaceBackend(database, objects, {
        "/notes.txt": "before",
      });
      const workspace = await backend.create("project-1");
      await workspace.write("/notes.txt", "after", {
        change: changeMetadata(
          "corrupt-revert",
          "2026-07-24T00:00:00.000Z",
        ),
      });

      const connection = await database.open();
      const damage = connection.transaction(
        ["project_filesystems", "opfs_files", "file_changes"],
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
            .objectStore("opfs_files")
            .get(["project-1", "/notes.txt"]),
        ),
        requestValue(
          damage
            .objectStore("file_changes")
            .get(["project-1", "corrupt-revert"]),
        ),
      ]);
      const contentId = file.content_id;
      testCase.corrupt({ marker, file, change });
      damage.objectStore("opfs_files").put(file);
      damage.objectStore("file_changes").put(change);
      await completion;
      const writeAttempts = objects.write_attempts;

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
      assert.equal(objects.write_attempts, writeAttempts);

      const verification = connection.transaction(
        [
          "project_filesystems",
          "opfs_files",
          "file_changes",
          "file_change_quarantines",
        ],
        "readonly",
      );
      const verificationComplete = transactionComplete(verification);
      const [currentMarker, currentFile, currentChange, quarantines] =
        await Promise.all([
          requestValue(
            verification
              .objectStore("project_filesystems")
              .get("project-1"),
          ),
          requestValue(
            verification
              .objectStore("opfs_files")
              .get(["project-1", "/notes.txt"]),
          ),
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
      assert.equal(currentMarker.workspace_revision, 1);
      assert.equal(currentFile.content_id, contentId);
      assert.equal(currentChange.reverted_at_workspace_revision, null);
      assert.equal(
        quarantines.length,
        testCase.corrupts_receipt ? 1 : 0,
      );
      assert.equal(
        await objects.read(
          currentFile.storage_id,
          currentFile.content_id,
        ),
        "after",
      );
      database.close();
    });
  }
});

test("OPFS rejects receipts forged at a replacement incarnation baseline", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-baseline-forgery-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  await backend.create("project-1");
  await backend.delete("project-1");
  const workspace = await backend.create("project-1", {
    initial_files: [{ path: "/notes.txt", content: "after" }],
  });
  await workspace.write("/receipt-source.txt", "source", {
    change: changeMetadata(
      "baseline-forgery",
      "2026-07-24T00:00:00.000Z",
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
  const writeAttempts = objects.write_attempts;

  assert.equal(marker.incarnation_baseline_revision, 1);
  await assert.rejects(
    workspace.revertChange("baseline-forgery"),
    (error) => error instanceof WorkspaceCorruptionError,
  );
  assert.equal(objects.write_attempts, writeAttempts);
  assert.deepEqual(await workspace.read("/notes.txt"), {
    workspace_revision: 2,
    path_revision: 1,
    content: "after",
  });
  database.close();
});

test("an OPFS write racing a revert never loses the later content", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-revert-write-race-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const runUncoordinated = (operation) => operation();
  const firstBackend = new OpfsWorkspaceBackend(
    database,
    objects,
    { "/notes.txt": "before" },
    runUncoordinated,
  );
  const first = await firstBackend.create("project-1");
  await first.write("/notes.txt", "after", {
    change: changeMetadata(
      "raced-revert",
      "2026-07-24T00:00:00.000Z",
    ),
  });
  const second = await new OpfsWorkspaceBackend(
    database,
    objects,
    {},
    runUncoordinated,
  ).open("project-1");

  const [revert, write] = await Promise.allSettled([
    first.revertChange("raced-revert"),
    second.write("/notes.txt", "later"),
  ]);
  assert.equal(write.status, "fulfilled");
  if (revert.status === "rejected") {
    assert.equal(revert.reason?.code, "conflict");
  } else {
    assert.equal(revert.value.revert_outcome, "applied");
  }

  const current = await first.read("/notes.txt");
  assert.equal(current.content, "later");
  assert.equal(current.path_revision, current.workspace_revision);
  const receipt = await first.getChange("raced-revert");
  if (revert.status === "fulfilled") {
    assert.equal(current.workspace_revision, 3);
    assert.equal(
      receipt.change.reverted_at_workspace_revision,
      2,
    );
  } else {
    assert.equal(current.workspace_revision, 2);
    assert.equal(
      receipt.change.reverted_at_workspace_revision,
      null,
    );
  }
  database.close();
});

test("OPFS export captures metadata once and reads each immutable object once", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-bulk-snapshot-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  const initialFiles = Array.from({ length: 64 }, (_, index) => ({
    path: `/nested/${index.toString().padStart(2, "0")}/file.txt`,
    content: `content-${index}`,
  }));
  const workspace = await backend.create("project-1", {
    initial_files: initialFiles,
  });
  workspace.list = async () => {
    throw new Error("Bulk capture must not traverse OPFS listings.");
  };
  workspace.read = async () => {
    throw new Error("Bulk capture must not reload OPFS metadata per file.");
  };

  const captured = await capturePortableWorkspace(workspace);

  assert.equal(captured.workspace_revision, 0);
  assert.deepEqual(captured.snapshot.files, initialFiles);
  assert.equal(objects.read_attempts, initialFiles.length);
  database.close();
});

test("OPFS orphan reconciliation keeps retained workspaces and schedules cleanup", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-orphans-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  const retained = await backend.create("retained");
  const orphan = await backend.create("orphan");
  await retained.write("/kept.txt", "kept");
  await orphan.write("/removed.txt", "removed");
  const orphanStorageId = (
    await readWorkspaceStorageState(database, "orphan")
  ).marker.opfs_storage_id;

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
  assert.equal(objects.storages.has(orphanStorageId), false);
  const recreated = await backend.create("orphan", {
    initial_files: [],
  });
  assert.equal((await recreated.list("/")).workspace_revision, 2);
  database.close();
});

test("browser storage delegates orphan reconciliation to its selected backend", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-browser-orphans-${crypto.randomUUID()}`,
  );
  let probes = 0;
  const backend = new BrowserWorkspaceBackend(
    database,
    {},
    async () => {
      probes += 1;
      throw new DOMException("unavailable", "NotSupportedError");
    },
  );
  await backend.create("retained");
  await backend.create("orphan");

  await backend.reconcileOrphanedWorkspaces(["retained"]);

  assert.equal(probes, 1);
  await backend.open("retained");
  await assert.rejects(
    backend.open("orphan"),
    (error) => error?.code === "not_found",
  );
  database.close();
});

test("browser storage selects OPFS after one successful root probe", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-select-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  let probes = 0;
  const backend = new BrowserWorkspaceBackend(
    database,
    { "/README.md": "configured seed" },
    async () => {
      probes += 1;
      return createWritableProbeRoot();
    },
    () => objects,
  );

  const initialFiles = [
    { path: "imported\\file.txt", content: "imported" },
  ];
  const workspaceCreation = backend.create("project-1", {
    initial_files: initialFiles,
  });
  initialFiles[0].path = "/mutated.txt";
  initialFiles[0].content = "mutated";
  const workspace = await workspaceCreation;
  assert.deepEqual(await workspace.read("/imported/file.txt"), {
    workspace_revision: 0,
    path_revision: 0,
    content: "imported",
  });
  await assert.rejects(
    workspace.read("/README.md"),
    (error) => error?.code === "not_found",
  );
  await workspace.write("/opfs.txt", "selected");
  assert.equal(
    (await (await backend.open("project-1")).read("/opfs.txt")).content,
    "selected",
  );
  assert.equal(probes, 1);
  assert.equal(
    (await readWorkspaceStorageState(database, "project-1"))
      .marker.content_storage,
    "opfs",
  );
  database.close();
});

test("OPFS creation serializes and coalesces duplicate initial objects", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-initial-batch-${crypto.randomUUID()}`,
  );
  const objects = new StrictInitialWriteObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});

  const workspace = await backend.create("project-1", {
    initial_files: [
      { path: "/first.txt", content: "shared" },
      { path: "/second.txt", content: "shared" },
      { path: "/empty-a.txt", content: "" },
      { path: "/empty-b.txt", content: "" },
    ],
  });

  assert.equal(objects.write_attempts, 2);
  assert.equal(objects.max_concurrent_writes, 1);
  assert.equal((await workspace.read("/first.txt")).content, "shared");
  assert.equal((await workspace.read("/second.txt")).content, "shared");
  assert.equal((await workspace.read("/empty-a.txt")).content, "");
  assert.equal((await workspace.read("/empty-b.txt")).content, "");

  const state = await readWorkspaceStorageState(database, "project-1");
  assert.equal(state.opfs_files.length, 4);
  assert.equal(
    new Set(state.opfs_files.map((file) => file.content_id)).size,
    2,
  );
  database.close();
});

test("a failed OPFS initial batch is unpublished, cleaned, and retryable", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-initial-failure-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  objects.fail_before_write_attempt = 2;
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  const initialFiles = [
    { path: "/first.txt", content: "first" },
    { path: "/second.txt", content: "second" },
    { path: "/third.txt", content: "third" },
  ];

  await assert.rejects(
    backend.create("project-1", {
      initial_files: initialFiles,
    }),
    /injected object write failure/,
  );

  const failedState = await readWorkspaceStorageState(
    database,
    "project-1",
  );
  assert.equal(failedState.marker, undefined);
  assert.equal(failedState.inline_files.length, 0);
  assert.equal(failedState.opfs_files.length, 0);
  assert.equal(objects.write_attempts, 2);
  assert.equal(objects.storages.size, 1);
  const [failedStorageId] = objects.storages.keys();
  assert.ok(failedStorageId);
  assert.deepEqual(
    (await readOpfsCleanupRecords(database)).map((record) => ({
      storage_id: record.storage_id,
      content_id: record.content_id,
    })),
    [{ storage_id: failedStorageId, content_id: null }],
  );

  objects.fail_before_write_attempt = null;
  const retried = await backend.create("project-1", {
    initial_files: initialFiles,
  });
  assert.equal((await retried.read("/first.txt")).content, "first");
  assert.equal((await retried.read("/second.txt")).content, "second");
  assert.equal((await retried.read("/third.txt")).content, "third");

  const retriedState = await readWorkspaceStorageState(
    database,
    "project-1",
  );
  assert.equal(retriedState.marker.content_storage, "opfs");
  assert.equal(retriedState.opfs_files.length, 3);
  assert.notEqual(retriedState.marker.opfs_storage_id, failedStorageId);
  assert.equal(objects.storages.has(failedStorageId), false);
  assert.equal(objects.storages.size, 1);
  assert.deepEqual(await readOpfsCleanupRecords(database), []);
  database.close();
});

test("browser storage falls back when OPFS cannot create writable streams", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-readonly-${crypto.randomUUID()}`,
  );
  const backend = new BrowserWorkspaceBackend(
    database,
    {},
    async () => ({
      async getFileHandle() {
        return {};
      },
      async removeEntry() {},
    }),
  );

  await backend.create("project-1");
  assert.equal(
    (await readWorkspaceStorageState(database, "project-1"))
      .marker.content_storage,
    "indexeddb",
  );
  database.close();
});

test("browser storage falls back when navigator.storage is unavailable", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-no-storage-${crypto.randomUUID()}`,
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });

  try {
    const backend = new BrowserWorkspaceBackend(database, {});
    await backend.create("project-1");
    assert.equal(
      (await readWorkspaceStorageState(database, "project-1"))
        .marker.content_storage,
      "indexeddb",
    );
  } finally {
    database.close();
    if (navigatorDescriptor) {
      Object.defineProperty(
        globalThis,
        "navigator",
        navigatorDescriptor,
      );
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  }
});

test("a transient OPFS probe failure is retried instead of cached", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-probe-retry-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  let probes = 0;
  const backend = new BrowserWorkspaceBackend(
    database,
    {},
    async () => {
      probes += 1;
      if (probes === 1) {
        throw new DOMException("busy", "UnknownError");
      }
      return createWritableProbeRoot();
    },
    () => objects,
  );

  await assert.rejects(backend.create("project-1"), /busy/);
  await backend.create("project-1");
  assert.equal(probes, 2);
  assert.equal(
    (await readWorkspaceStorageState(database, "project-1"))
      .marker.content_storage,
    "opfs",
  );
  database.close();
});

test("browser storage falls back only when the OPFS root probe fails", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-fallback-${crypto.randomUUID()}`,
  );
  let probes = 0;
  const backend = new BrowserWorkspaceBackend(
    database,
    {},
    async () => {
      probes += 1;
      throw new DOMException("unavailable", "NotSupportedError");
    },
  );

  const workspace = await backend.create("project-1");
  await workspace.write("/inline.txt", "fallback");
  assert.equal(probes, 1);
  assert.equal(
    (await readWorkspaceStorageState(database, "project-1"))
      .marker.content_storage,
    "indexeddb",
  );
  database.close();
});

test("OPFS migration preserves inline files, receipts, and revision", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-opfs-migrate-${crypto.randomUUID()}`;
  const database = new ResearchBoxDatabase(factory, databaseName);
  const inlineBackend = new IndexedDbWorkspaceBackend(database, {
    "/README.md": "legacy seed",
  });
  const inline = await inlineBackend.create("project-1");
  await inline.write("/notes.txt", "first", {
    change: changeMetadata("change-1", "2026-07-24T01:00:00.000Z"),
  });
  await inline.write("/notes.txt", "second");

  const objects = new MemoryWorkspaceObjectStore();
  const opfsBackend = new OpfsWorkspaceBackend(database, objects, {});
  const migrated = await opfsBackend.open("project-1");

  assert.deepEqual(await migrated.read("/README.md"), {
    workspace_revision: 2,
    path_revision: 0,
    content: "legacy seed",
  });
  assert.deepEqual(await migrated.read("/notes.txt"), {
    workspace_revision: 2,
    path_revision: 2,
    content: "second",
  });
  assert.deepEqual(
    (await migrated.listChanges()).changes.map(
      (change) => change.change_id,
    ),
    ["change-1"],
  );

  const state = await readWorkspaceStorageState(database, "project-1");
  assert.equal(state.marker.content_storage, "opfs");
  assert.equal(state.marker.opfs_migration, null);
  assert.equal(state.inline_files.length, 0);
  assert.deepEqual(
    state.opfs_files.map((file) => file.path).sort(),
    ["/README.md", "/notes.txt"],
  );
  assert.ok(
    state.opfs_files.every(
      (file) =>
        file.storage_id === state.marker.opfs_storage_id &&
        file.incarnation_id === state.marker.incarnation_id &&
        file.migration_id === null,
    ),
  );
  await assert.rejects(
    inlineBackend.open("project-1"),
    /cannot be opened by the legacy IndexedDB backend/,
  );

  database.close();
  const reopenedDatabase = new ResearchBoxDatabase(factory, databaseName);
  const reopened = await new OpfsWorkspaceBackend(
    reopenedDatabase,
    objects,
    {},
  ).open("project-1");
  assert.deepEqual(await reopened.read("/notes.txt"), {
    workspace_revision: 2,
    path_revision: 2,
    content: "second",
  });
  reopenedDatabase.close();
});

test("OPFS migration preserves reversible deleted path generations", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-migrate-delete-${crypto.randomUUID()}`,
  );
  const inlineBackend = new IndexedDbWorkspaceBackend(database, {
    "/deleted.txt": "before",
  });
  const inline = await inlineBackend.create("project-1");
  await inline.remove("/deleted.txt", {
    expected_content: "before",
    change: {
      ...changeMetadata(
        "migrated-delete",
        "2026-07-24T01:00:00.000Z",
      ),
      tool_name: "remove_file",
    },
  });

  const objects = new MemoryWorkspaceObjectStore();
  const migrated = await new OpfsWorkspaceBackend(
    database,
    objects,
    {},
  ).open("project-1");
  assert.deepEqual(await migrated.getPathState("/deleted.txt"), {
    workspace_revision: 1,
    path: "/deleted.txt",
    kind: "missing",
    path_revision: 1,
  });
  assert.equal(
    (await migrated.getChange("migrated-delete")).change?.change_kind,
    "deleted",
  );

  const reverted = await migrated.revertChange("migrated-delete");
  assert.equal(reverted.workspace_revision, 2);
  assert.equal(reverted.revert_outcome, "applied");
  assert.deepEqual(await migrated.read("/deleted.txt"), {
    workspace_revision: 2,
    path_revision: 2,
    content: "before",
  });
  assert.equal(objects.write_attempts, 1);
  database.close();
});

test("OPFS migration keeps legacy receipts readable but not revertible", async () => {
  const factory = new IDBFactory();
  const databaseName =
    `researchbox-opfs-legacy-receipt-${crypto.randomUUID()}`;
  const database = new ResearchBoxDatabase(factory, databaseName);
  const inlineBackend = new IndexedDbWorkspaceBackend(database, {});
  const inline = await inlineBackend.create("project-1");
  await inline.write("/legacy.txt", "legacy", {
    change: changeMetadata(
      "legacy-change",
      "2026-07-24T01:00:00.000Z",
    ),
  });

  const connection = await database.open();
  const damage = connection.transaction(
    ["files", "file_changes"],
    "readwrite",
  );
  const damageComplete = transactionComplete(damage);
  const fileStore = damage.objectStore("files");
  const changeStore = damage.objectStore("file_changes");
  const storedFile = await requestValue(
    fileStore.get(["project-1", "/legacy.txt"]),
  );
  const storedChange = await requestValue(
    changeStore.get(["project-1", "legacy-change"]),
  );
  delete storedFile.path_revision;
  delete storedChange.applied_workspace_revision;
  delete storedChange.reverted_at_workspace_revision;
  fileStore.put(storedFile);
  changeStore.put(storedChange);
  await damageComplete;

  const objects = new MemoryWorkspaceObjectStore();
  const migrated = await new OpfsWorkspaceBackend(
    database,
    objects,
    {},
  ).open("project-1");
  assert.deepEqual(await migrated.read("/legacy.txt"), {
    workspace_revision: 1,
    path_revision: 0,
    content: "legacy",
  });
  const receipt = await migrated.getChange("legacy-change");
  assert.equal(receipt.change.applied_workspace_revision, null);
  assert.equal(
    receipt.change.reverted_at_workspace_revision,
    null,
  );
  await assert.rejects(
    migrated.revertChange("legacy-change"),
    (error) => error?.code === "conflict",
  );
  assert.equal((await migrated.list("/")).workspace_revision, 1);
  database.close();
});

test("core bootstrap migrates and reopens an inline project through OPFS", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-opfs-core-${crypto.randomUUID()}`;
  let database = new ResearchBoxDatabase(factory, databaseName);
  const inlineBackend = new IndexedDbWorkspaceBackend(database, {});
  const firstEvents = [];
  const firstCore = createTestCore(
    new IndexedDbProjectStore(database),
    inlineBackend,
    firstEvents,
  );
  await firstCore.handle(createCommand("bootstrap", {}));
  const projectId = latestCoreState(firstEvents).active_project_id;
  await (await inlineBackend.open(projectId)).write(
    "/migrated.txt",
    "from IndexedDB",
  );

  const objects = new MemoryWorkspaceObjectStore();
  const migratedEvents = [];
  const migratedBackend = new BrowserWorkspaceBackend(
    database,
    {},
    async () => createWritableProbeRoot(),
    () => objects,
  );
  const migratedCore = createTestCore(
    new IndexedDbProjectStore(database),
    migratedBackend,
    migratedEvents,
  );
  await migratedCore.handle(createCommand("bootstrap", {}));
  assert.equal(latestCoreState(migratedEvents).workspace_revision, 1);
  assert.equal(
    (
      await (await migratedBackend.open(projectId)).read(
        "/migrated.txt",
      )
    ).content,
    "from IndexedDB",
  );

  database.close();
  database = new ResearchBoxDatabase(factory, databaseName);
  const reopenedBackend = new BrowserWorkspaceBackend(
    database,
    {},
    async () => createWritableProbeRoot(),
    () => objects,
  );
  const reopenedEvents = [];
  const reopenedCore = createTestCore(
    new IndexedDbProjectStore(database),
    reopenedBackend,
    reopenedEvents,
  );
  await reopenedCore.handle(createCommand("bootstrap", {}));
  assert.equal(latestCoreState(reopenedEvents).workspace_revision, 1);
  assert.equal(
    (
      await (await reopenedBackend.open(projectId)).read(
        "/migrated.txt",
      )
    ).content,
    "from IndexedDB",
  );
  database.close();
});

test("core bootstrap isolates a malformed OPFS receipt without denying its committed mutation", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-core-quarantine-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  const projectStore = new IndexedDbProjectStore(database);
  const initialEvents = [];
  await createTestCore(projectStore, backend, initialEvents).handle(
    createCommand("bootstrap", {}),
  );
  const initial = await projectStore.load();
  assert.ok(initial);
  const projectId = initial.active_project_id;
  const timestamp = "2026-07-24T02:00:00.000Z";
  const runId = "run-quarantined-change";
  initial.state_revision += 1;
  initial.active_session_id = "session-1";
  initial.projects[0].last_session_id = "session-1";
  initial.sessions.push({
    session_id: "session-1",
    project_id: projectId,
    title: "Recovered mutation",
    title_is_custom: false,
    created_at: timestamp,
    updated_at: timestamp,
    selected_model: {
      provider_id: testModel.provider,
      model_id: testModel.id,
    },
    reasoning_effort: "default",
  });
  initial.documents.push({
    format_version: SESSION_DOCUMENT_FORMAT_VERSION,
    session_id: "session-1",
    project_id: projectId,
    input_draft: "",
    timeline: [
      {
        type: "user_message",
        entry_id: "user-quarantined-change",
        run_id: runId,
        created_at: timestamp,
        content: "Write the note",
      },
      {
        type: "assistant_message",
        entry_id: "assistant-quarantined-change",
        run_id: runId,
        created_at: timestamp,
        status: "complete",
        api: testModel.api,
        provider: testModel.provider,
        model: testModel.id,
        usage: emptyUsage(),
        stop_reason: "tool_use",
        blocks: [
          {
            type: "tool_call",
            block_id: "block-quarantined-change",
            tool_call_id: "tool-quarantined-change",
            tool_name: "write_file",
            arguments: {
              path: "/note.txt",
              content: "committed",
            },
          },
        ],
      },
    ],
  });
  await projectStore.save(initial, initial.state_revision - 1);

  const workspace = await backend.open(projectId);
  await workspace.write("/note.txt", "committed", {
    change: changeMetadata(
      "quarantined-change",
      "2026-07-24T02:00:00.001Z",
    ),
  });
  const connection = await database.open();
  const damage = connection.transaction("file_changes", "readwrite");
  const damageComplete = transactionComplete(damage);
  const changeStore = damage.objectStore("file_changes");
  const receipt = await requestValue(
    changeStore.get([projectId, "quarantined-change"]),
  );
  receipt.after_content = 42;
  changeStore.put(receipt);
  await damageComplete;

  const events = [];
  await createTestCore(projectStore, backend, events).handle(
    createCommand("bootstrap", {}),
  );
  const ready = events.find((event) => event.type === "ready");
  const notice = events.find(
    (event) => event.type === "workspace_recovery_notice",
  );
  assert.ok(ready);
  assert.ok(notice);
  assert.equal(notice.payload.quarantined_receipt_count, 1);
  assert.equal(notice.payload.pending_receipt_count, 0);
  const recoveredResult = ready.payload.state.timeline.at(-1);
  assert.equal(recoveredResult.type, "tool_result");
  assert.equal(recoveredResult.is_error, true);
  assert.match(recoveredResult.content, /operation may have completed/i);
  assert.doesNotMatch(
    recoveredResult.content,
    /before it produced a result/i,
  );
  assert.deepEqual(await workspace.read("/note.txt"), {
    workspace_revision: 1,
    path_revision: 1,
    content: "committed",
  });
  database.close();
});

test("an interrupted OPFS copy resumes from its durable candidates", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-opfs-resume-${crypto.randomUUID()}`;
  let database = new ResearchBoxDatabase(factory, databaseName);
  const inlineBackend = new IndexedDbWorkspaceBackend(database, {
    "/first.txt": "first",
    "/second.txt": "second",
  });
  await inlineBackend.create("project-1");

  const objects = new MemoryWorkspaceObjectStore();
  objects.fail_before_write_attempt = 2;
  const firstAttempt = new OpfsWorkspaceBackend(database, objects, {});
  await assert.rejects(
    firstAttempt.open("project-1"),
    /injected object write failure/,
  );

  const interrupted = await readWorkspaceStorageState(
    database,
    "project-1",
  );
  assert.equal(interrupted.marker.content_storage, "indexeddb");
  assert.ok(interrupted.marker.opfs_migration);
  assert.equal(interrupted.inline_files.length, 2);
  assert.equal(interrupted.opfs_files.length, 1);

  database.close();
  database = new ResearchBoxDatabase(factory, databaseName);
  objects.fail_before_write_attempt = null;
  const resumedBackend = new OpfsWorkspaceBackend(database, objects, {});
  const resumed = await resumedBackend.open("project-1");

  assert.equal(objects.write_attempts, 3);
  assert.equal((await resumed.read("/first.txt")).content, "first");
  assert.equal((await resumed.read("/second.txt")).content, "second");
  const finished = await readWorkspaceStorageState(database, "project-1");
  assert.equal(finished.marker.content_storage, "opfs");
  assert.equal(finished.marker.opfs_migration, null);
  assert.equal(finished.inline_files.length, 0);
  assert.equal(finished.opfs_files.length, 2);
  database.close();
});

test("a post-object-write failure leaves inline storage authoritative", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-opfs-post-write-${crypto.randomUUID()}`;
  let database = new ResearchBoxDatabase(factory, databaseName);
  const inlineBackend = new IndexedDbWorkspaceBackend(database, {
    "/only.txt": "durable",
  });
  await inlineBackend.create("project-1");

  const objects = new MemoryWorkspaceObjectStore();
  objects.fail_after_write_attempt = 1;
  const firstAttempt = new OpfsWorkspaceBackend(database, objects, {});
  await assert.rejects(
    firstAttempt.open("project-1"),
    /injected post-write failure/,
  );
  const interrupted = await readWorkspaceStorageState(
    database,
    "project-1",
  );
  assert.equal(interrupted.marker.content_storage, "indexeddb");
  assert.equal(interrupted.opfs_files.length, 0);
  assert.equal(interrupted.inline_files[0].content, "durable");

  database.close();
  database = new ResearchBoxDatabase(factory, databaseName);
  objects.fail_after_write_attempt = null;
  const resumed = await new OpfsWorkspaceBackend(
    database,
    objects,
    {},
  ).open("project-1");
  assert.equal((await resumed.read("/only.txt")).content, "durable");
  assert.equal(objects.write_attempts, 2);
  database.close();
});

test("OPFS startup removes stale inline rows left after the ownership flip", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-cleanup-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {
    "/kept.txt": "opfs",
  });
  await backend.create("project-1");

  const connection = await database.open();
  const damage = connection.transaction(databaseStores.files, "readwrite");
  const damageComplete = transactionComplete(damage);
  damage.objectStore(databaseStores.files).put({
    project_id: "project-1",
    path: "/stale.txt",
    content: "stale inline copy",
  });
  await damageComplete;

  const reopened = await backend.open("project-1");
  assert.equal((await reopened.read("/kept.txt")).content, "opfs");
  const state = await readWorkspaceStorageState(database, "project-1");
  assert.equal(state.inline_files.length, 0);
  database.close();
});

test("OPFS scopes project work separately while keeping global scans exclusive", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-lock-scopes-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const scopes = [];
  const runScoped = async (operation, scope) => {
    scopes.push(structuredClone(scope));
    return operation();
  };
  const backend = new OpfsWorkspaceBackend(
    database,
    objects,
    { "/notes.txt": "before" },
    runScoped,
  );

  const workspace = await backend.create("project-1");
  await workspace.write("/notes.txt", "after");
  await workspace.list("/");
  await backend.reconcileOrphanedWorkspaces(["project-1"]);

  assert.deepEqual(scopes, [
    { kind: "project", project_id: "project-1" },
    { kind: "project", project_id: "project-1" },
    { kind: "global" },
    { kind: "project", project_id: "project-1" },
    { kind: "global" },
  ]);
  const [storage] = objects.storages.values();
  assert.equal(storage.size, 1);
  assert.equal((await workspace.read("/notes.txt")).content, "after");
  database.close();
});

test("OPFS scoped locks coordinate concurrent backend instances", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-lock-concurrency-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const locks = new TestOpfsScopeRunner();
  const firstBackend = new OpfsWorkspaceBackend(
    database,
    objects,
    {},
    locks.run,
  );
  const secondBackend = new OpfsWorkspaceBackend(
    database,
    objects,
    {},
    locks.run,
  );
  const firstProjectGate = deferredValue();
  const secondProjectGate = deferredValue();
  const sameProjectGate = deferredValue();
  const globalGate = deferredValue();
  const started = [];

  const firstProject = firstBackend.enqueueProject(
    "project-1",
    async () => {
      started.push("first_project");
      await firstProjectGate.promise;
    },
  );
  const secondProject = secondBackend.enqueueProject(
    "project-2",
    async () => {
      started.push("second_project");
      await secondProjectGate.promise;
    },
  );
  await waitForTestCondition(
    () =>
      started.includes("first_project") &&
      started.includes("second_project"),
  );

  secondProjectGate.resolve();
  await secondProject;
  const sameProject = secondBackend.enqueueProject(
    "project-1",
    async () => {
      started.push("same_project");
      await sameProjectGate.promise;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.includes("same_project"), false);

  firstProjectGate.resolve();
  await firstProject;
  await waitForTestCondition(() => started.includes("same_project"));

  const globalCleanup = firstBackend.enqueueGlobal(async () => {
    started.push("global_cleanup");
    await globalGate.promise;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.includes("global_cleanup"), false);

  sameProjectGate.resolve();
  await sameProject;
  await waitForTestCondition(() => started.includes("global_cleanup"));

  const projectDuringCleanup = secondBackend.enqueueProject(
    "project-2",
    async () => {
      started.push("project_during_cleanup");
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.includes("project_during_cleanup"), false);

  globalGate.resolve();
  await Promise.all([globalCleanup, projectDuringCleanup]);
  assert.equal(started.includes("project_during_cleanup"), true);
  database.close();
});

test("OPFS cleanup removes an object only after its final manifest reference", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-object-cleanup-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  const workspace = await backend.create("project-1");
  await workspace.write("/first.txt", "shared");
  await workspace.write("/second.txt", "shared");
  await workspace.write("/first.txt", "replacement");

  const [storage] = objects.storages.values();
  assert.equal(storage.size, 2);
  await workspace.remove("/second.txt");
  assert.equal(storage.size, 2);

  await workspace.list("/");
  assert.equal(storage.size, 1);
  assert.equal((await workspace.read("/first.txt")).content, "replacement");
  database.close();
});

test("OPFS rejects non-canonical object-store content identifiers", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-object-id-${crypto.randomUUID()}`,
  );
  const objects = new UppercaseContentIdObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  const workspace = await backend.create("project-1");

  await assert.rejects(
    workspace.write("/invalid.txt", "content"),
    (error) =>
      error.code === "conflict" &&
      /object store returned invalid metadata/.test(error.message),
  );
  assert.equal(objects.write_attempts, 0);
  assert.deepEqual(await workspace.list("/"), {
    workspace_revision: 0,
    entries: [],
  });
  assert.equal(
    (await readWorkspaceStorageState(database, "project-1")).opfs_files
      .length,
    0,
  );
  database.close();
});

test("OPFS deletion commits even when namespace cleanup fails", async () => {
  const factory = new IDBFactory();
  const database = new ResearchBoxDatabase(
    factory,
    `researchbox-opfs-delete-${crypto.randomUUID()}`,
  );
  const objects = new MemoryWorkspaceObjectStore();
  const backend = new OpfsWorkspaceBackend(database, objects, {});
  const workspace = await backend.create("project-1");
  await workspace.write("/old.txt", "old");
  const oldStorageId = (
    await readWorkspaceStorageState(database, "project-1")
  ).marker.opfs_storage_id;
  objects.delete_failures_remaining = 1;

  await backend.delete("project-1");
  await assert.rejects(
    backend.open("project-1"),
    (error) => error.code === "not_found",
  );
  const recreated = await backend.create("project-1");
  assert.deepEqual(await recreated.list("/"), {
    workspace_revision: 2,
    entries: [],
  });
  assert.equal(objects.storages.has(oldStorageId), false);
  database.close();
});

class MemoryWorkspaceObjectStore {
  storages = new Map();
  write_attempts = 0;
  read_attempts = 0;
  fail_before_write_attempt = null;
  fail_after_write_attempt = null;
  delete_failures_remaining = 0;

  async identify(content) {
    const bytes = new TextEncoder().encode(content);
    return {
      content_id: await sha256Hex(bytes),
      byte_size: bytes.byteLength,
    };
  }

  async write(storageId, content) {
    this.write_attempts += 1;
    if (this.fail_before_write_attempt === this.write_attempts) {
      throw new Error("injected object write failure");
    }
    const identified = await this.identify(content);
    const storage = this.storages.get(storageId) ?? new Map();
    storage.set(identified.content_id, content);
    this.storages.set(storageId, storage);
    if (this.fail_after_write_attempt === this.write_attempts) {
      throw new Error("injected post-write failure");
    }
    return {
      ...identified,
    };
  }

  async read(storageId, contentId) {
    this.read_attempts += 1;
    const content = this.storages.get(storageId)?.get(contentId);
    if (content === undefined) {
      throw new Error(`Missing workspace object: ${storageId}/${contentId}`);
    }
    return content;
  }

  async deleteObject(storageId, contentId) {
    const storage = this.storages.get(storageId);
    storage?.delete(contentId);
    if (storage?.size === 0) this.storages.delete(storageId);
  }

  async deleteStorage(storageId) {
    if (this.delete_failures_remaining > 0) {
      this.delete_failures_remaining -= 1;
      throw new Error("injected storage deletion failure");
    }
    this.storages.delete(storageId);
  }
}

class UppercaseContentIdObjectStore extends MemoryWorkspaceObjectStore {
  async identify(content) {
    const identified = await super.identify(content);
    return {
      ...identified,
      content_id: identified.content_id.toUpperCase(),
    };
  }
}

class StrictInitialWriteObjectStore extends MemoryWorkspaceObjectStore {
  active_writes = 0;
  max_concurrent_writes = 0;
  written_objects = new Set();

  async write(storageId, content) {
    const objectKey = JSON.stringify([storageId, content]);
    if (this.active_writes > 0) {
      throw new Error("overlapping object writes are not supported");
    }
    if (this.written_objects.has(objectKey)) {
      throw new Error("duplicate object writes are not supported");
    }

    this.active_writes += 1;
    this.max_concurrent_writes = Math.max(
      this.max_concurrent_writes,
      this.active_writes,
    );
    try {
      await Promise.resolve();
      const result = await super.write(storageId, content);
      this.written_objects.add(objectKey);
      return result;
    } finally {
      this.active_writes -= 1;
    }
  }
}

function createWritableProbeRoot() {
  return {
    async getFileHandle() {
      return {
        async createWritable() {
          return {
            async write() {},
            async close() {},
            async abort() {},
          };
        },
      };
    },
    async removeEntry() {},
  };
}

async function readWorkspaceStorageState(database, projectId) {
  const connection = await database.open();
  const transaction = connection.transaction(
    [
      databaseStores.project_filesystems,
      databaseStores.files,
      databaseStores.opfs_files,
    ],
    "readonly",
  );
  const completion = transactionComplete(transaction);
  const [marker, inlineFiles, opfsFiles] = await Promise.all([
    requestValue(
      transaction
        .objectStore(databaseStores.project_filesystems)
        .get(projectId),
    ),
    requestValue(
      transaction
        .objectStore(databaseStores.files)
        .index("by_project")
        .getAll(projectId),
    ),
    requestValue(
      transaction
        .objectStore(databaseStores.opfs_files)
        .index("by_project")
        .getAll(projectId),
    ),
  ]);
  await completion;
  return {
    marker,
    inline_files: inlineFiles,
    opfs_files: opfsFiles,
  };
}

async function readOpfsCleanupRecords(database) {
  const connection = await database.open();
  const transaction = connection.transaction(
    databaseStores.meta,
    "readonly",
  );
  const completion = transactionComplete(transaction);
  const records = await requestValue(
    transaction.objectStore(databaseStores.meta).getAll(),
  );
  await completion;
  return records.filter(
    (record) => record.record_type === "opfs_cleanup",
  );
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

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

class TestOpfsScopeRunner {
  activeGlobal = false;
  activeProjects = new Set();
  queue = [];

  run = (operation, scope = { kind: "global" }) =>
    new Promise((resolve, reject) => {
      this.queue.push({ operation, scope, resolve, reject });
      this.drain();
    });

  drain() {
    if (this.activeGlobal) return;
    const firstGlobalIndex = this.queue.findIndex(
      (request) => request.scope.kind === "global",
    );
    if (firstGlobalIndex === 0) {
      if (this.activeProjects.size === 0) {
        this.start(this.queue.shift());
      }
      return;
    }

    let limit =
      firstGlobalIndex === -1 ? this.queue.length : firstGlobalIndex;
    for (let index = 0; index < limit;) {
      const request = this.queue[index];
      const projectId = request.scope.project_id;
      if (this.activeProjects.has(projectId)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      limit -= 1;
      this.start(request);
    }
  }

  start(request) {
    if (request.scope.kind === "global") {
      this.activeGlobal = true;
    } else {
      this.activeProjects.add(request.scope.project_id);
    }
    void Promise.resolve()
      .then(request.operation)
      .then(request.resolve, request.reject)
      .finally(() => {
        if (request.scope.kind === "global") {
          this.activeGlobal = false;
        } else {
          this.activeProjects.delete(request.scope.project_id);
        }
        this.drain();
      });
  }
}

function deferredValue() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitForTestCondition(condition) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the OPFS lock test.");
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function changeMetadata(changeId, createdAt) {
  return {
    change_id: changeId,
    session_id: "session-1",
    tool_call_block_id: `block-${changeId}`,
    assistant_message_index: 1,
    tool_call_id: `tool-${changeId}`,
    tool_name: "write_file",
    created_at: createdAt,
  };
}

const testModel = {
  id: "test-model",
  name: "Test model",
  api: "researchbox-mock",
  provider: "researchbox",
  baseUrl: "/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

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

function createTestCore(projectStore, workspaceBackend, events) {
  return new ResearchBoxCore({
    projectStore,
    workspaceBackend,
    modelTransport: {
      async *stream() {
        yield { type: "done" };
      },
    },
    model: testModel,
    systemPrompt: "You are a test agent.",
    legacySessionRuntimeProvider: new PiSessionRuntimeProvider(),
    eventSink: (event) => events.push(event),
  });
}

function latestCoreState(events) {
  const event = [...events].reverse().find(
    (candidate) =>
      candidate.type === "ready" ||
      candidate.type === "state_snapshot",
  );
  assert.ok(event);
  return event.payload.state;
}
