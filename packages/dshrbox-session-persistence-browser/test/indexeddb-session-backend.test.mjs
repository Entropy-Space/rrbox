import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import {
  DshrboxSessionPersistence,
  MemoryDshrboxSessionBackend,
} from "@dshrbox/session-persistence";
import {
  IndexedDbDshrboxSessionBackend,
} from "@dshrbox/session-persistence-browser";
import {
  databaseStores,
  RESEARCHBOX_DATABASE_VERSION,
  ResearchBoxDatabase,
} from "@researchbox/storage-browser";
import "fake-indexeddb/auto";

test("persists canonical DSH sessions across IndexedDB reopen", async () => {
  const databaseName = `dshrbox-session-${crypto.randomUUID()}`;
  const firstDatabase = new ResearchBoxDatabase(indexedDB, databaseName);
  const firstBackend = new IndexedDbDshrboxSessionBackend(firstDatabase);
  const firstContext = await createContext(firstBackend);
  const id = SessionId("browser-session");
  try {
    const session = firstContext.sessions.create(id);
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await firstContext.sessions.flush(session);
  } finally {
    await firstContext.fiber.dispose();
    firstDatabase.close();
  }

  const secondDatabase = new ResearchBoxDatabase(indexedDB, databaseName);
  const secondBackend = new IndexedDbDshrboxSessionBackend(secondDatabase);
  const secondContext = await createContext(secondBackend);
  try {
    const loaded = await secondContext.sessionPersistence.load(id);
    assert.deepEqual(
      loaded.events.map((event) => event.type),
      ["turn/start", "turn/end"],
    );
    assert.deepEqual(await secondBackend.loadStoredFrom(id, 1), {
      meta: loaded.meta,
      events: [loaded.events[1]],
    });
    assert.deepEqual(
      (await secondBackend.list()).map((header) => String(header.id)),
      [String(id)],
    );

    const detached = await secondBackend.loadStored(id);
    detached.events[0].data.turn = 99;
    assert.equal((await secondBackend.loadStored(id)).events[0].data.turn, 1);
  } finally {
    await secondContext.fiber.dispose();
    secondDatabase.close();
  }
});

test("serializes concurrent appends and advances durable revisions", async () => {
  const values = await canonicalValues("concurrent-session");
  const database = new ResearchBoxDatabase(
    indexedDB,
    `dshrbox-concurrent-${crypto.randomUUID()}`,
  );
  const first = new IndexedDbDshrboxSessionBackend(database);
  const second = new IndexedDbDshrboxSessionBackend(database);
  await first.appendBatch(values.meta, [values.events[0]], false);
  const initialRevision = await first.readStoredRevision(values.meta.id);

  const results = await Promise.allSettled([
    first.appendBatch(values.meta, [values.events[1]], true),
    second.appendBatch(values.meta, [values.events[1]], true),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.notEqual(
    await first.readStoredRevision(values.meta.id),
    initialRevision,
  );
  assert.deepEqual(
    (await first.loadStored(values.meta.id)).events,
    values.events,
  );
  database.close();
});

test("commits repair closers and deletes sessions idempotently", async () => {
  const values = await canonicalValues("repair-session");
  const database = new ResearchBoxDatabase(
    indexedDB,
    `dshrbox-repair-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbDshrboxSessionBackend(database);
  await backend.appendBatch(values.meta, [values.events[0]], false);
  await backend.commitRepair(
    values.meta,
    undefined,
    [values.events[1]],
  );
  assert.deepEqual(
    (await backend.loadStored(values.meta.id)).events,
    values.events,
  );
  await assert.rejects(
    backend.commitRepair(values.meta, { torn: true }, []),
    /cannot contain a torn transactional tail/,
  );

  await backend.deleteStored(values.meta.id);
  await backend.deleteStored(values.meta.id);
  assert.equal(await backend.loadStored(values.meta.id), undefined);
  assert.equal(await backend.readStoredRevision(values.meta.id), undefined);
  assert.deepEqual(await backend.list(), []);
  database.close();
});

test("rejects a noncontiguous first batch without materializing", async () => {
  const values = await canonicalValues("invalid-session");
  const database = new ResearchBoxDatabase(
    indexedDB,
    `dshrbox-invalid-${crypto.randomUUID()}`,
  );
  const backend = new IndexedDbDshrboxSessionBackend(database);
  await assert.rejects(
    backend.appendBatch(values.meta, [values.events[1]], false),
    /does not match stored seq 0/,
  );
  assert.equal(await backend.loadStored(values.meta.id), undefined);
  database.close();
});

test("database version 10 additively upgrades version 9 storage", async () => {
  const databaseName = `dshrbox-upgrade-${crypto.randomUUID()}`;
  const legacy = await openLegacyDatabase(databaseName);
  const transaction = legacy.transaction("legacy_records", "readwrite");
  const completion = transactionCompletion(transaction);
  transaction.objectStore("legacy_records").put({
    key: "kept",
    value: "before-upgrade",
  });
  await completion;
  legacy.close();

  const database = new ResearchBoxDatabase(indexedDB, databaseName);
  const upgraded = await database.open();
  assert.equal(upgraded.version, RESEARCHBOX_DATABASE_VERSION);
  assert.equal(
    upgraded.objectStoreNames.contains(databaseStores.dsh_session_headers),
    true,
  );
  assert.equal(
    upgraded.objectStoreNames.contains(databaseStores.dsh_session_events),
    true,
  );
  const read = upgraded.transaction("legacy_records", "readonly");
  const readCompletion = transactionCompletion(read);
  assert.deepEqual(
    await requestValue(read.objectStore("legacy_records").get("kept")),
    { key: "kept", value: "before-upgrade" },
  );
  await readCompletion;
  database.close();
});

async function canonicalValues(sessionId) {
  const backend = new MemoryDshrboxSessionBackend();
  const context = await createContext(backend);
  const id = SessionId(sessionId);
  try {
    const session = context.sessions.create(id);
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await context.sessions.flush(session);
    return await backend.loadStored(id);
  } finally {
    await context.fiber.dispose();
  }
}

async function createContext(backend) {
  const context = new Context();
  await context.plugin(SessionStore);
  await context.plugin(DshrboxSessionPersistence, {
    backend,
    write_batch_max_delay_ms: 1,
  });
  return context;
}

function openLegacyDatabase(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 9);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("legacy_records", { keyPath: "key" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}
