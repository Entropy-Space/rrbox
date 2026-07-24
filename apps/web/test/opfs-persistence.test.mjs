import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { ResearchBoxCore } from "@researchbox/agent-core";
import { createCommand } from "@researchbox/protocol";
import {
  defineDurableWorkspaceBackendConformance,
  defineWorkspaceBackendConformance,
} from "@researchbox/vfs-testkit";
import {
  BrowserWorkspaceBackend,
  databaseStores,
  IndexedDbWorkspaceBackend,
  IndexedDbProjectStore,
  ResearchBoxDatabase,
} from "../browser/persistence/index.ts";
import { OpfsWorkspaceBackend } from "../browser/persistence/opfs-workspace-backend.ts";

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
    content: "legacy seed",
  });
  assert.deepEqual(await migrated.read("/notes.txt"), {
    workspace_revision: 2,
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
    content: "second",
  });
  reopenedDatabase.close();
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
