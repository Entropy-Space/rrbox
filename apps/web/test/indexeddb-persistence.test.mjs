import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import {
  defineDurableWorkspaceBackendConformance,
  defineWorkspaceBackendConformance,
} from "@researchbox/vfs-testkit";
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
  expectedState.projects[0].new_chat_draft = "A new chat draft";
  expectedState.documents[0].input_draft = "A session draft";

  const secondDatabase = new ResearchBoxDatabase(factory, databaseName);
  const secondStore = new IndexedDbProjectStore(secondDatabase);
  const secondProvider = new IndexedDbWorkspaceBackend(secondDatabase, {});
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

  const created = await filesystem.write(
    "/notes.txt",
    "alpha\nbeta\n",
    { change: workspaceChangeMetadata("change-1", "write_file") },
  );
  assert.equal(created.change_kind, "created");
  assert.deepEqual(
    {
      additions: created.change.additions,
      deletions: created.change.deletions,
      byte_size: created.change.byte_size,
    },
    { additions: 2, deletions: 0, byte_size: 11 },
  );

  const updated = await filesystem.write(
    "/notes.txt",
    "alpha\ngamma\n",
    {
      expected_content: "alpha\nbeta\n",
      change: workspaceChangeMetadata("change-2", "replace_text"),
    },
  );
  assert.equal(updated.change_kind, "updated");
  assert.deepEqual(
    {
      additions: updated.change.additions,
      deletions: updated.change.deletions,
      byte_size: updated.change.byte_size,
    },
    { additions: 1, deletions: 1, byte_size: 12 },
  );

  const unchanged = await filesystem.write(
    "/notes.txt",
    "alpha\ngamma\n",
    { change: workspaceChangeMetadata("change-3", "write_file") },
  );
  assert.equal(unchanged.change_kind, "unchanged");
  assert.equal(unchanged.change, null);
  firstDatabase.close();

  const reopenedDatabase = new ResearchBoxDatabase(factory, databaseName);
  const reopenedProvider = new IndexedDbWorkspaceBackend(
    reopenedDatabase,
    {},
  );
  const reopened = await reopenedProvider.open("project-1");
  assert.equal(await reopened.read("/notes.txt"), "alpha\ngamma\n");
  assert.deepEqual(
    (await reopened.listChanges()).map((change) => ({
      change_id: change.change_id,
      path: change.path,
      change_kind: change.change_kind,
      before_content: change.before_content,
      after_content: change.after_content,
    })),
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
  assert.deepEqual(await recreated.list("/"), []);
  assert.deepEqual(await recreated.listChanges(), []);
  reopenedDatabase.close();
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
  assert.ok(["first", "second"].includes(await filesystem.read("/notes.txt")));
  assert.equal((await filesystem.listChanges()).length, 1);

  const winner = await filesystem.read("/notes.txt");
  await assert.rejects(
    filesystem.remove("/notes.txt", { expected_content: "original" }),
    /changed before it could be removed/,
  );
  await filesystem.remove("/notes.txt", { expected_content: winner });
  await assert.rejects(filesystem.read("/notes.txt"), /File not found/);
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
  assert.equal(await current.read("/current.txt"), "current");
  assert.deepEqual(await current.listChanges(), []);
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

test("IndexedDB v2 migration persists model selections and a v3 timeline exactly once", async () => {
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
        format_version: 3,
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

  assert.deepEqual(await filesystem.list("/"), []);
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
  assert.equal(await filesystem.read("/legacy.txt"), "legacy");

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

  const secondHandle = await provider.open("legacy-project");
  await secondHandle.write("/legacy.txt", "updated", {
    expected_content: "legacy",
  });
  assert.equal(await filesystem.read("/legacy.txt"), "updated");
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
  assert.equal(await repairedHandle.read("/notes.txt"), "persisted");
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
  assert.equal(connection.version, 3);

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
        format_version: 3,
        session_id: "session-1",
        project_id: "project-1",
        input_draft: "",
        timeline: [],
      },
    ],
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
