import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import {
  DshrboxSessionPersistence,
  MemoryDshrboxSessionBackend,
} from "@dshrbox/session-persistence";

const SESSION_ID = "session-dsh-persistence";

test("persists and reloads canonical DSH session values", async () => {
  const backend = new MemoryDshrboxSessionBackend();
  const first = await createContext(backend);
  try {
    const session = first.sessions.create(SessionId(SESSION_ID));
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await first.sessions.flush(session);

    const stored = await backend.loadStored(SessionId(SESSION_ID));
    assert.equal(String(stored.meta.id), SESSION_ID);
    assert.deepEqual(
      stored.events.map((event) => event.type),
      ["turn/start", "turn/end"],
    );
  } finally {
    await first.fiber.dispose();
  }

  const second = await createContext(backend);
  try {
    const loaded = await second.sessionPersistence.load(
      SessionId(SESSION_ID),
    );
    assert.equal(String(loaded.meta.id), SESSION_ID);
    assert.deepEqual(
      loaded.events.map((event) => event.type),
      ["turn/start", "turn/end"],
    );
    assert.deepEqual(
      await second.sessionPersistence.readFrom(SessionId(SESSION_ID), 1),
      {
        meta: loaded.meta,
        events: [loaded.events[1]],
      },
    );
    assert.equal(
      (await second.sessionPersistence.listSnapshots()).length,
      1,
    );
  } finally {
    await second.fiber.dispose();
  }
});

test("returns detached stored values", async () => {
  const backend = new MemoryDshrboxSessionBackend();
  const context = await createContext(backend);
  try {
    const session = context.sessions.create(SessionId(SESSION_ID));
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await context.sessions.flush(session);
    const first = await backend.loadStored(SessionId(SESSION_ID));
    first.events[0].data.turn = 99;
    const second = await backend.loadStored(SessionId(SESSION_ID));
    assert.equal(second.events[0].data.turn, 1);
  } finally {
    await context.fiber.dispose();
  }
});

test("deletes stored sessions idempotently", async () => {
  const backend = new MemoryDshrboxSessionBackend();
  const context = await createContext(backend);
  const id = SessionId(SESSION_ID);
  try {
    const session = context.sessions.create(id);
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await context.sessions.flush(session);
    assert.notEqual(await backend.loadStored(id), undefined);

    await backend.deleteStored(id);
    await backend.deleteStored(id);
    assert.equal(await backend.loadStored(id), undefined);
    assert.equal(await backend.readStoredRevision(id), undefined);
    assert.deepEqual(await backend.list(), []);
  } finally {
    await context.fiber.dispose();
  }
});

async function createContext(backend) {
  const context = new Context();
  await context.plugin(SessionStore);
  await context.plugin(DshrboxSessionPersistence, {
    backend,
    write_batch_max_delay_ms: 1,
  });
  return context;
}
