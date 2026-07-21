import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbProjectFileSystemProvider,
  IndexedDbProjectStore,
  ResearchBoxDatabase,
} from "../browser/persistence/index.ts";

test("IndexedDB project state and files survive reopening the database", async () => {
  const factory = new IDBFactory();
  const databaseName = `researchbox-test-${crypto.randomUUID()}`;
  const firstDatabase = new ResearchBoxDatabase(factory, databaseName);
  const firstStore = new IndexedDbProjectStore(firstDatabase);
  const firstProvider = new IndexedDbProjectFileSystemProvider(firstDatabase, {
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
  expectedState.projects[0].new_chat_draft = "A new chat draft";
  expectedState.documents[0].input_draft = "A session draft";

  const secondDatabase = new ResearchBoxDatabase(factory, databaseName);
  const secondStore = new IndexedDbProjectStore(secondDatabase);
  const secondProvider = new IndexedDbProjectFileSystemProvider(secondDatabase, {});
  assert.deepEqual(await secondStore.load(), expectedState);
  assert.equal(
    await (await secondProvider.open("project-1")).read("/notes.txt"),
    "persisted",
  );

  await secondProvider.create("project-2");
  assert.deepEqual(await (await secondProvider.open("project-2")).list("/"), []);
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

test("IndexedDB project-store migration is persisted exactly once", async () => {
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
    schema_version: 2,
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
      schema_version: 2,
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
  const provider = new IndexedDbProjectFileSystemProvider(database, {});
  const filesystem = await provider.open("legacy-project");

  assert.deepEqual(await filesystem.list("/"), []);
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
  assert.equal(connection.version, 2);

  database.close();
  await Promise.resolve();
  await deleteDatabase(factory, databaseName);
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
  const provider = new IndexedDbProjectFileSystemProvider(database, {});
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
    assert.equal(await filesystem.read("/a"), "root file");
    await assert.rejects(filesystem.read("/a/b"), /File not found/);
  } else {
    await assert.rejects(filesystem.read("/a"), /Path is a directory/);
    assert.equal(await filesystem.read("/a/b"), "nested file");
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

function createState() {
  const timestamp = "2026-07-22T00:00:00.000Z";
  return {
    schema_version: 2,
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
      },
    ],
    documents: [
      {
        format_version: 2,
        session_id: "session-1",
        project_id: "project-1",
        input_draft: "",
        messages: [],
        activities: [],
        agent_messages: [],
      },
    ],
  };
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
