import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryProjectStore,
  ProjectStoreConflictError,
  parseProjectStoreState,
  parseProjectStoreStateWithMigration,
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

test("project store accepts a virtual new chat with no persisted sessions", () => {
  const state = createVirtualState(1);
  assert.deepEqual(parseProjectStoreState(state), state);
});

test("project store validation rejects broken ownership and selection invariants", () => {
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
  mismatchedLastSession.sessions.push(
    createSessionRecord("session-2", "Second chat"),
  );
  mismatchedLastSession.documents.push(createSessionDocument("session-2"));
  assert.throws(
    () => parseProjectStoreState(mismatchedLastSession),
    /Active session must be the active project's last session/,
  );

  const mismatchedVirtualSelection = createState(1);
  mismatchedVirtualSelection.active_session_id = null;
  assert.throws(
    () => parseProjectStoreState(mismatchedVirtualSelection),
    /Active new chat must be the active project's last view/,
  );

  const persistedPlaceholder = createState(1);
  persistedPlaceholder.sessions[0].title = "New chat";
  assert.throws(
    () => parseProjectStoreState(persistedPlaceholder),
    /Unsubmitted new chats must not be persisted/,
  );
});

test("project draft writes preserve exact text and do not change the revision", async () => {
  const store = new MemoryProjectStore();
  const state = createState(1);
  state.documents[0].input_draft = "existing session draft";
  await store.save(state, null);

  await store.saveInputDraft({
    project_id: "project-1",
    session_id: null,
    input_draft: "  unfinished project prompt\n",
  });

  const loaded = await store.load();
  assert.equal(loaded.state_revision, 1);
  assert.equal(
    loaded.projects[0].new_chat_draft,
    "  unfinished project prompt\n",
  );
  assert.equal(loaded.documents[0].input_draft, "existing session draft");
});

test("session draft writes update only the owned document", async () => {
  const store = new MemoryProjectStore();
  const state = createState(1);
  state.projects[0].new_chat_draft = "existing project draft";
  state.sessions.push(createSessionRecord("session-2", "Second chat"));
  state.documents.push(createSessionDocument("session-2", "second draft"));
  await store.save(state, null);

  await store.saveInputDraft({
    project_id: "project-1",
    session_id: "session-1",
    input_draft: "  exact session draft\n",
  });

  const loaded = await store.load();
  assert.equal(loaded.state_revision, 1);
  assert.equal(loaded.projects[0].new_chat_draft, "existing project draft");
  assert.equal(loaded.documents[0].input_draft, "  exact session draft\n");
  assert.equal(loaded.documents[1].input_draft, "second draft");

  const next = structuredClone(loaded);
  next.state_revision = 2;
  next.projects[0].name = "Saved after draft";
  await store.save(next, 1);
  assert.equal((await store.load()).state_revision, 2);
});

test("draft writes reject missing projects and cross-project sessions", async () => {
  const store = new MemoryProjectStore();
  const state = createState(1);
  state.projects.push({
    project_id: "project-2",
    name: "Other workspace",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    last_session_id: null,
    new_chat_draft: "",
    new_chat_model: createDefaultModelSelection(),
  });
  await store.save(state, null);

  await assert.rejects(
    store.saveInputDraft({
      project_id: "missing-project",
      session_id: null,
      input_draft: "not saved",
    }),
    /Project not found/,
  );
  await assert.rejects(
    store.saveInputDraft({
      project_id: "project-2",
      session_id: "session-1",
      input_draft: "not saved",
    }),
    /does not belong to the project/,
  );
  assert.deepEqual(await store.load(), state);
});

test("v1 migration removes only an unambiguous empty placeholder", () => {
  const legacy = createLegacyState();
  const result = parseProjectStoreStateWithMigration(legacy);

  assert.equal(result.was_migrated, true);
  assert.deepEqual(result.state, createVirtualState(legacy.state_revision));
});

test("v1 migration preserves custom and nonempty legacy sessions", () => {
  const legacy = createLegacyState();
  legacy.sessions = [
    createLegacySessionRecord("custom-session", true),
    createLegacySessionRecord("nonempty-session", false),
  ];
  legacy.documents = [
    createLegacySessionDocument("custom-session"),
    createLegacySessionDocument("nonempty-session", [
      {
        id: "message-1",
        role: "user",
        content: "Keep this session",
        created_at: TIMESTAMP,
        status: "complete",
      },
    ]),
  ];
  legacy.active_session_id = "nonempty-session";
  legacy.projects[0].last_session_id = "nonempty-session";

  const result = parseProjectStoreStateWithMigration(legacy);

  assert.equal(result.was_migrated, true);
  assert.deepEqual(
    result.state.sessions.map((session) => session.session_id),
    ["custom-session", "nonempty-session"],
  );
  assert.deepEqual(
    result.state.documents.map((document) => ({
      session_id: document.session_id,
      format_version: document.format_version,
      input_draft: document.input_draft,
    })),
    [
      {
        session_id: "custom-session",
        format_version: 2,
        input_draft: "",
      },
      {
        session_id: "nonempty-session",
        format_version: 2,
        input_draft: "",
      },
    ],
  );
  assert.equal(result.state.documents[1].messages[0].content, "Keep this session");
  assert.equal(result.state.projects[0].new_chat_draft, "");
  assert.deepEqual(
    result.state.projects[0].new_chat_model,
    createDefaultModelSelection(),
  );
  assert.deepEqual(
    result.state.sessions.map((session) => session.selected_model),
    [createDefaultModelSelection(), createDefaultModelSelection()],
  );
  assert.equal(result.state.state_revision, legacy.state_revision);
});

test("v2 migration adds default model selections without changing drafts", () => {
  const draft = createDraftState(9);
  draft.projects[0].new_chat_draft = "new chat draft";
  draft.documents[0].input_draft = "session draft";

  const result = parseProjectStoreStateWithMigration(draft);

  assert.equal(result.was_migrated, true);
  assert.equal(result.state.schema_version, 3);
  assert.equal(result.state.state_revision, draft.state_revision);
  assert.deepEqual(
    result.state.projects[0].new_chat_model,
    createDefaultModelSelection(),
  );
  assert.deepEqual(
    result.state.sessions[0].selected_model,
    createDefaultModelSelection(),
  );
  assert.equal(result.state.projects[0].new_chat_draft, "new chat draft");
  assert.equal(result.state.documents[0].input_draft, "session draft");
});

const TIMESTAMP = "2026-07-22T00:00:00.000Z";

export function createState(stateRevision) {
  return {
    schema_version: 3,
    state_revision: stateRevision,
    active_project_id: "project-1",
    active_session_id: "session-1",
    projects: [
      {
        project_id: "project-1",
        name: "Local workspace",
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        last_session_id: "session-1",
        new_chat_draft: "",
        new_chat_model: createDefaultModelSelection(),
      },
    ],
    sessions: [createSessionRecord("session-1", "First chat")],
    documents: [createSessionDocument("session-1")],
  };
}

function createVirtualState(stateRevision) {
  return {
    schema_version: 3,
    state_revision: stateRevision,
    active_project_id: "project-1",
    active_session_id: null,
    projects: [
      {
        project_id: "project-1",
        name: "Local workspace",
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        last_session_id: null,
        new_chat_draft: "",
        new_chat_model: createDefaultModelSelection(),
      },
    ],
    sessions: [],
    documents: [],
  };
}

function createSessionRecord(sessionId, title) {
  return {
    session_id: sessionId,
    project_id: "project-1",
    title,
    title_is_custom: false,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    selected_model: createDefaultModelSelection(),
  };
}

function createDraftState(stateRevision) {
  const state = createState(stateRevision);
  const projects = structuredClone(state.projects);
  const sessions = structuredClone(state.sessions);
  for (const project of projects) delete project.new_chat_model;
  for (const session of sessions) delete session.selected_model;
  return {
    ...state,
    schema_version: 2,
    projects,
    sessions,
  };
}

function createDefaultModelSelection() {
  return {
    provider_id: "researchbox",
    model_id: "researchbox-mock",
  };
}

function createSessionDocument(sessionId, inputDraft = "") {
  return {
    format_version: 2,
    session_id: sessionId,
    project_id: "project-1",
    input_draft: inputDraft,
    messages: [],
    activities: [],
    agent_messages: [],
  };
}

function createLegacyState() {
  return {
    schema_version: 1,
    state_revision: 7,
    active_project_id: "project-1",
    active_session_id: "placeholder-session",
    projects: [
      {
        project_id: "project-1",
        name: "Local workspace",
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
        last_session_id: "placeholder-session",
      },
    ],
    sessions: [createLegacySessionRecord("placeholder-session", false)],
    documents: [createLegacySessionDocument("placeholder-session")],
  };
}

function createLegacySessionRecord(sessionId, titleIsCustom) {
  return {
    session_id: sessionId,
    project_id: "project-1",
    title: "New chat",
    title_is_custom: titleIsCustom,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

function createLegacySessionDocument(sessionId, messages = []) {
  return {
    format_version: 1,
    session_id: sessionId,
    project_id: "project-1",
    messages,
    activities: [],
    agent_messages: [],
  };
}
