import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, {
  SessionId,
} from "@deepseek-ai/dsh-session";
import {
  DSHRBOX_RUNTIME_ID,
  DSHRBOX_RUNTIME_STATE_FORMAT_VERSION,
  DshrboxSessionPersistence,
} from "@dshrbox/session-persistence";
import {
  MemoryProjectStore,
  PROJECT_STORE_SCHEMA_VERSION,
  SESSION_DOCUMENT_FORMAT_VERSION,
  createSessionHistory,
} from "@researchbox/project-store";

const SESSION_ID = "session-dsh-persistence";
const PROJECT_ID = "project-dsh-persistence";

test("persists and reloads DSH events through the rrbox project store", async () => {
  const projectStore = new MemoryProjectStore(initialState(true));
  const first = await createContext(projectStore);
  try {
    const session = first.sessions.create(SessionId(SESSION_ID));
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await first.sessions.flush(session);

    const stored = await projectStore.load();
    const runtimeState = stored.documents[0].runtime_state;
    assert.equal(runtimeState.runtime_id, DSHRBOX_RUNTIME_ID);
    assert.equal(
      runtimeState.format_version,
      DSHRBOX_RUNTIME_STATE_FORMAT_VERSION,
    );
    assert.deepEqual(
      runtimeState.payload.events.map((event) => event.type),
      ["turn/start", "turn/end"],
    );
  } finally {
    await first.fiber.dispose();
  }

  const second = await createContext(projectStore);
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

test("does not claim legacy rrbox session documents", async () => {
  const projectStore = new MemoryProjectStore(initialState(false));
  const context = await createContext(projectStore);
  try {
    assert.deepEqual(await context.sessionPersistence.list(), []);
  } finally {
    await context.fiber.dispose();
  }
});

async function createContext(projectStore) {
  const context = new Context();
  await context.plugin(SessionStore);
  await context.plugin(DshrboxSessionPersistence, {
    project_store: projectStore,
    write_batch_max_delay_ms: 1,
  });
  return context;
}

function initialState(withDshMarker) {
  const now = "2026-08-18T00:00:00.000Z";
  return {
    schema_version: PROJECT_STORE_SCHEMA_VERSION,
    state_revision: 1,
    active_project_id: PROJECT_ID,
    active_session_id: SESSION_ID,
    projects: [{
      project_id: PROJECT_ID,
      name: "DSH persistence",
      created_at: now,
      updated_at: now,
      last_session_id: SESSION_ID,
      new_chat_draft: "",
      new_chat_model: {
        provider_id: "test-provider",
        model_id: "test-model",
      },
      new_chat_reasoning_effort: "default",
    }],
    sessions: [{
      session_id: SESSION_ID,
      project_id: PROJECT_ID,
      title: "DSH persistence",
      title_is_custom: false,
      created_at: now,
      updated_at: now,
      selected_model: {
        provider_id: "test-provider",
        model_id: "test-model",
      },
      reasoning_effort: "default",
    }],
    documents: [{
      format_version: SESSION_DOCUMENT_FORMAT_VERSION,
      session_id: SESSION_ID,
      project_id: PROJECT_ID,
      input_draft: "",
      timeline: [{
        type: "user_message",
        entry_id: "legacy-user",
        run_id: "legacy-run",
        created_at: now,
        content: "Existing message",
      }],
      history: createSessionHistory([{
        type: "user_message",
        entry_id: "legacy-user",
        run_id: "legacy-run",
        created_at: now,
        content: "Existing message",
      }]),
      ...(withDshMarker
        ? {
            runtime_state: {
              runtime_id: DSHRBOX_RUNTIME_ID,
              format_version: DSHRBOX_RUNTIME_STATE_FORMAT_VERSION,
              payload: null,
            },
          }
        : {}),
    }],
  };
}
