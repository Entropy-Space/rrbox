import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryProjectStore,
  ProjectStoreConflictError,
  parseProjectStoreState,
} from "../src/index.ts";

test("memory project store clones state and enforces optimistic revisions", async () => {
  const store = new MemoryProjectStore();
  const first = createState(1);
  await store.save(first, null);

  const loaded = await store.load();
  assert.deepEqual(loaded, first);
  loaded.projects[0].name = "Changed only in caller";
  assert.equal((await store.load()).projects[0].name, "Local workspace");

  const second = createState(2);
  second.projects[0].name = "Saved name";
  await store.save(second, 1);
  await assert.rejects(store.save(createState(2), 1), ProjectStoreConflictError);
});

test("project store validation rejects broken ownership invariants", () => {
  const invalid = createState(1);
  invalid.sessions[0].project_id = "missing-project";
  assert.throws(
    () => parseProjectStoreState(invalid),
    /Active session does not belong|unknown project/,
  );

  const missingDocument = createState(1);
  missingDocument.documents = [];
  assert.throws(
    () => parseProjectStoreState(missingDocument),
    /Session document is missing/,
  );

  const mismatchedLastSession = createState(1);
  mismatchedLastSession.active_session_id = "session-2";
  mismatchedLastSession.sessions.push({
    ...mismatchedLastSession.sessions[0],
    session_id: "session-2",
    title: "Second chat",
  });
  mismatchedLastSession.documents.push({
    ...mismatchedLastSession.documents[0],
    session_id: "session-2",
  });
  assert.throws(
    () => parseProjectStoreState(mismatchedLastSession),
    /Active session must be the active project's last session/,
  );
});

export function createState(stateRevision) {
  const timestamp = "2026-07-22T00:00:00.000Z";
  return {
    schema_version: 1,
    state_revision: stateRevision,
    active_project_id: "project-1",
    active_session_id: "session-1",
    projects: [
      {
        project_id: "project-1",
        name: "Local workspace",
        created_at: timestamp,
        updated_at: timestamp,
        last_session_id: "session-1",
      },
    ],
    sessions: [
      {
        session_id: "session-1",
        project_id: "project-1",
        title: "New chat",
        title_is_custom: false,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    documents: [
      {
        format_version: 1,
        session_id: "session-1",
        project_id: "project-1",
        messages: [],
        activities: [],
        agent_messages: [],
      },
    ],
  };
}
