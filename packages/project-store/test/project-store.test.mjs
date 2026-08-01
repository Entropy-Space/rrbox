import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryProjectStore,
  ProjectStoreConflictError,
  SESSION_DOCUMENT_FORMAT_VERSION,
  parseProjectStoreState,
  parseProjectStoreStateWithMigration,
} from "../src/index.ts";

const TIMESTAMP = "2026-07-22T00:00:00.000Z";
const TIMESTAMP_MS = Date.parse(TIMESTAMP);

test("memory project store clones v4 timelines and enforces revisions", async () => {
  const store = new MemoryProjectStore();
  const first = createState(1);
  await store.save(first, null);

  const loaded = await store.load();
  assert.deepEqual(loaded, first);
  loaded.projects[0].name = "Changed only in caller";
  loaded.documents[0].timeline[1].blocks[0].text = "Changed only in caller";
  const unchanged = await store.load();
  assert.equal(unchanged.projects[0].name, "Local workspace");
  assert.equal(unchanged.documents[0].timeline[1].blocks[0].text, "Done.");

  const second = createState(2);
  second.projects[0].name = "Saved name";
  await store.save(second, 1);
  await assert.rejects(store.save(createState(2), 1), ProjectStoreConflictError);
});

test("memory project mutations rebase canonical state and own revisions", async () => {
  const store = new MemoryProjectStore(createState(1));

  const renamed = await store.mutate((draft) => {
    draft.projects[0].name = "Renamed workspace";
    return draft;
  });
  assert.equal(renamed.changed, true);
  assert.equal(renamed.state.state_revision, 2);
  assert.equal(renamed.state.projects[0].name, "Renamed workspace");

  renamed.state.projects[0].name = "Changed only in caller";
  const unchanged = await store.mutate(() => null);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.state.state_revision, 2);
  assert.equal(unchanged.state.projects[0].name, "Renamed workspace");

  await assert.rejects(
    store.mutate(async (draft) => draft),
    /must be synchronous/,
  );
  await assert.rejects(
    store.mutate((draft) => structuredClone(draft)),
    /provided draft/,
  );
});

test("memory project store publishes only committed changes", async () => {
  const store = new MemoryProjectStore();
  const changes = [];
  store.subscribe(() => {
    throw new Error("A listener must not break persistence.");
  });
  const unsubscribe = store.subscribe((change) => changes.push(change));

  await store.save(createState(1), null);
  await store.mutate(() => null);
  await assert.rejects(
    store.save(createState(1), null),
    ProjectStoreConflictError,
  );
  await store.saveInputDraft({
    project_id: "project-1",
    session_id: null,
    input_draft: "Changed draft",
  });

  assert.deepEqual(
    changes.map((change) => change.state_revision),
    [1, 2],
  );
  assert.equal(changes[0].source_id, changes[1].source_id);
  assert.notEqual(changes[0].source_id, "");

  unsubscribe();
  await store.mutate((draft) => {
    draft.projects[0].name = "No longer observed";
    return draft;
  });
  assert.equal(changes.length, 2);
});

test("v4 documents contain only the normalized timeline", () => {
  const state = parseProjectStoreState(createState(1));
  const document = state.documents[0];

  assert.equal(document.format_version, SESSION_DOCUMENT_FORMAT_VERSION);
  assert.deepEqual(
    document.timeline.map((entry) => entry.type),
    ["user_message", "assistant_message"],
  );
  assert.equal("messages" in document, false);
  assert.equal("activities" in document, false);
  assert.equal("agent_messages" in document, false);
});

test("v3 normalized timelines infer legacy file-change tool names", () => {
  const cases = [
    ["write_file", "created"],
    ["write_file", "updated"],
    ["replace_text", "updated"],
  ];

  for (const [toolName, changeKind] of cases) {
    const stored = createVersionThreeFileChangeState(toolName, changeKind);
    const original = structuredClone(stored);
    const result = parseProjectStoreStateWithMigration(stored);
    const migrated = structuredClone(result.state);
    const fileChange = migrated.documents[0].timeline[2].file_change;

    assert.equal(result.was_migrated, true);
    assert.equal(
      migrated.documents[0].format_version,
      SESSION_DOCUMENT_FORMAT_VERSION,
    );
    assert.equal(fileChange.tool_name, toolName);

    migrated.documents[0].format_version = 3;
    delete fileChange.tool_name;
    assert.deepEqual(migrated, original);
    assert.deepEqual(stored, original);
  }
});

test("v4 normalized timelines require explicit matching file-change tools", () => {
  const missing = createVersionThreeFileChangeState(
    "write_file",
    "created",
  );
  missing.documents[0].format_version = SESSION_DOCUMENT_FORMAT_VERSION;
  assert.throws(
    () => parseProjectStoreState(missing),
    /Invalid workspace change tool name/,
  );

  for (const invalidToolName of [null, "read_file"]) {
    const invalid = createVersionThreeFileChangeState(
      "write_file",
      "created",
    );
    invalid.documents[0].format_version = SESSION_DOCUMENT_FORMAT_VERSION;
    invalid.documents[0].timeline[2].file_change.tool_name = invalidToolName;
    assert.throws(
      () => parseProjectStoreState(invalid),
      /Invalid workspace change tool name/,
    );
  }

  const mismatched = createVersionThreeFileChangeState(
    "write_file",
    "updated",
  );
  mismatched.documents[0].format_version = SESSION_DOCUMENT_FORMAT_VERSION;
  mismatched.documents[0].timeline[2].file_change.tool_name = "replace_text";
  assert.throws(
    () => parseProjectStoreState(mismatched),
    /file_change must match tool_name/,
  );
});

test("v3 normalized timeline migration does not repair invalid tool identities", () => {
  const explicitMismatch = createVersionThreeFileChangeState(
    "write_file",
    "updated",
  );
  explicitMismatch.documents[0].timeline[2].file_change.tool_name =
    "replace_text";
  assert.throws(
    () => parseProjectStoreState(explicitMismatch),
    /file_change must match tool_name/,
  );

  for (const [toolName, changeKind] of [
    ["read_file", "created"],
    ["remove_file", "deleted"],
    ["replace_text", "created"],
  ]) {
    const invalid = createVersionThreeFileChangeState(toolName, changeKind);
    assert.throws(
      () => parseProjectStoreState(invalid),
      /Invalid workspace change tool name|does not match change_kind/,
    );
  }
});

test("project store accepts a virtual new chat with no persisted sessions", () => {
  const state = createVirtualState(1);
  assert.deepEqual(parseProjectStoreState(state), state);
});

test("v2 migration follows agent transcript order and enriches tool metadata", () => {
  const stored = createTranscriptState();
  const result = parseProjectStoreStateWithMigration(stored);
  const timeline = result.state.documents[0].timeline;

  assert.equal(result.was_migrated, true);
  assert.equal(
    result.state.documents[0].format_version,
    SESSION_DOCUMENT_FORMAT_VERSION,
  );
  assert.deepEqual(
    timeline.map((entry) => entry.type),
    [
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
    ],
  );
  assert.equal(timeline[0].entry_id, "legacy-user");
  assert.equal(timeline[1].entry_id, "legacy-assistant");
  assert.deepEqual(
    timeline[1].blocks.map((block) => block.type),
    ["reasoning", "assistant_text", "tool_call"],
  );
  assert.deepEqual(timeline[1].blocks[0], {
    type: "reasoning",
    block_id: "legacy:session-1:entry:1:block:0",
    text: "I should write the note.",
    thinking_signature: "opaque-thinking",
    redacted: false,
  });
  assert.equal(timeline[1].blocks[2].label, "Writing /notes/note.md");
  assert.deepEqual(timeline[1].blocks[2].arguments, {
    path: "/notes/note.md",
    content: "# Note",
  });
  assert.equal(timeline[1].stop_reason, "tool_use");
  assert.equal(timeline[1].provider, "researchbox");
  assert.equal(timeline[1].usage.total_tokens, 18);

  const resultEntry = timeline[2];
  assert.equal(
    resultEntry.tool_call_block_id,
    timeline[1].blocks[2].block_id,
  );
  assert.equal(resultEntry.summary, "Created · +1 −0");
  assert.deepEqual(resultEntry.file_change, createFileChange());
  assert.equal(timeline[3].blocks[0].text, "Done.");
  assert.equal("agent_messages" in result.state.documents[0], false);
});

test("v2 migration disambiguates repeated provider tool call IDs", () => {
  const stored = createTranscriptState();
  const document = stored.documents[0];
  document.messages.push(
    createLegacyMessage("second-user", "user", "Update it"),
    createLegacyMessage("second-assistant", "assistant", "Updated."),
  );
  document.activities.push({
    ...createActivity(),
    activity_id: "activity-2",
    message_id: "second-assistant",
    summary: "Updated · +1 −1",
    file_change: {
      ...createFileChange(),
      change_id: "change-2",
      change_kind: "updated",
      deletions: 1,
    },
  });
  document.agent_messages.push(
    {
      role: "user",
      content: "Update it",
      timestamp: TIMESTAMP_MS + 4,
    },
    createStoredAssistant({
      content: [
        {
          type: "tool_call",
          id: "write-note",
          name: "write_file",
          arguments: {
            path: "/notes/note.md",
            content: "# Updated",
          },
        },
      ],
      stop_reason: "toolUse",
      timestamp: TIMESTAMP_MS + 5,
    }),
    {
      role: "tool_result",
      tool_call_id: "write-note",
      tool_name: "write_file",
      content: [{ type: "text", text: '{"path":"/notes/note.md"}' }],
      is_error: false,
      timestamp: TIMESTAMP_MS + 6,
    },
    createStoredAssistant({
      content: [{ type: "text", text: "Updated." }],
      timestamp: TIMESTAMP_MS + 7,
    }),
  );

  const timeline = parseProjectStoreState(stored).documents[0].timeline;
  const calls = timeline
    .filter((entry) => entry.type === "assistant_message")
    .flatMap((entry) =>
      entry.blocks.filter((block) => block.type === "tool_call"),
    );
  const results = timeline.filter((entry) => entry.type === "tool_result");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool_call_id, calls[1].tool_call_id);
  assert.notEqual(calls[0].block_id, calls[1].block_id);
  assert.deepEqual(
    results.map((entry) => entry.tool_call_block_id),
    calls.map((block) => block.block_id),
  );
  assert.notEqual(timeline[0].run_id, timeline[4].run_id);
});

test("v2 migration scopes activity metadata by tool name and legacy run", () => {
  const stored = createTranscriptState();
  const document = stored.documents[0];
  document.activities = [
    {
      ...createActivity(),
      activity_id: "wrong-tool-activity",
      tool_name: "read_file",
      label: "Must not attach",
    },
    {
      ...createActivity(),
      activity_id: "second-run-activity",
      message_id: "second-assistant",
      label: "Writing the second note",
      summary: "Updated · +1 −1",
      file_change: {
        ...createFileChange(),
        change_id: "second-change",
        change_kind: "updated",
        deletions: 1,
      },
    },
  ];
  document.messages.push(
    createLegacyMessage("second-user", "user", "Update it"),
    createLegacyMessage("second-assistant", "assistant", "Updated."),
  );
  document.agent_messages.push(
    {
      role: "user",
      content: "Update it",
      timestamp: TIMESTAMP_MS + 4,
    },
    createStoredAssistant({
      content: [
        {
          type: "tool_call",
          id: "write-note",
          name: "write_file",
          arguments: {
            path: "/notes/note.md",
            content: "# Updated",
          },
        },
      ],
      stop_reason: "toolUse",
      timestamp: TIMESTAMP_MS + 5,
    }),
    {
      role: "tool_result",
      tool_call_id: "write-note",
      tool_name: "write_file",
      content: [{ type: "text", text: '{"path":"/notes/note.md"}' }],
      is_error: false,
      timestamp: TIMESTAMP_MS + 6,
    },
    createStoredAssistant({
      content: [{ type: "text", text: "Updated." }],
      timestamp: TIMESTAMP_MS + 7,
    }),
  );

  const timeline = parseProjectStoreState(stored).documents[0].timeline;
  const calls = timeline
    .filter((entry) => entry.type === "assistant_message")
    .flatMap((entry) =>
      entry.blocks.filter((block) => block.type === "tool_call"),
    );
  const results = timeline.filter((entry) => entry.type === "tool_result");

  assert.equal(calls[0].label, undefined);
  assert.equal(results[0].summary, undefined);
  assert.equal(results[0].file_change, undefined);
  assert.equal(calls[1].label, "Writing the second note");
  assert.equal(results[1].summary, "Updated · +1 −1");
  assert.equal(results[1].file_change.change_id, "second-change");
});

test("invalid agent transcript falls back deterministically to UI snapshots", () => {
  const stored = createTranscriptState();
  stored.documents[0].agent_messages = [
    { role: "custom", content: "not decodable" },
  ];

  const first = parseProjectStoreState(stored);
  const second = parseProjectStoreState(stored);
  const timeline = first.documents[0].timeline;

  assert.deepEqual(first, second);
  assert.deepEqual(
    timeline.map((entry) => entry.type),
    ["user_message", "assistant_message", "tool_result"],
  );
  assert.equal(timeline[0].entry_id, "legacy-user");
  assert.equal(timeline[1].entry_id, "legacy-assistant");
  assert.deepEqual(
    timeline[1].blocks.map((block) => block.type),
    ["assistant_text", "tool_call"],
  );
  assert.equal(timeline[1].blocks[1].label, "Writing /notes/note.md");
  assert.equal(
    timeline[2].tool_call_block_id,
    timeline[1].blocks[1].block_id,
  );
  assert.deepEqual(timeline[2].file_change, createFileChange());
});

test("fallback migration closes historical running tools before a later run", () => {
  const stored = createTranscriptState();
  const document = stored.documents[0];
  document.activities[0].status = "running";
  delete document.activities[0].summary;
  delete document.activities[0].file_change;
  document.messages.push(
    createLegacyMessage("second-user", "user", "Continue"),
    createLegacyMessage("second-assistant", "assistant", "Continued."),
  );
  document.agent_messages = [{ role: "custom", content: "not decodable" }];

  const timeline = parseProjectStoreState(stored).documents[0].timeline;

  assert.deepEqual(
    timeline.map((entry) => entry.type),
    [
      "user_message",
      "assistant_message",
      "tool_result",
      "user_message",
      "assistant_message",
    ],
  );
  assert.equal(timeline[2].is_error, true);
  assert.match(timeline[2].summary, /interrupted/);
});

test("migration preserves reasoning redaction and opaque signatures", () => {
  const stored = createTranscriptState();
  const reasoning = stored.documents[0].agent_messages[1].content[0];
  reasoning.redacted = true;

  const timeline = parseProjectStoreState(stored).documents[0].timeline;
  assert.deepEqual(timeline[1].blocks[0], {
    type: "reasoning",
    block_id: "legacy:session-1:entry:1:block:0",
    text: "I should write the note.",
    thinking_signature: "opaque-thinking",
    redacted: true,
  });
  assert.equal(timeline[1].blocks[1].text_signature, "opaque-text");
  assert.equal(timeline[1].blocks[2].thought_signature, "opaque-thought");
});

test("v1 migration removes only an unambiguous empty placeholder", () => {
  const legacy = createLegacyState();
  const result = parseProjectStoreStateWithMigration(legacy);

  assert.equal(result.was_migrated, true);
  assert.deepEqual(result.state, createVirtualState(legacy.state_revision));
});

test("v1 migration preserves nonempty sessions as v4 timelines", () => {
  const legacy = createLegacyState();
  legacy.sessions[0].title = "Kept chat";
  legacy.documents[0].messages.push(
    createLegacyMessage("message-1", "user", "Keep this session"),
  );
  legacy.active_session_id = "placeholder-session";
  legacy.projects[0].last_session_id = "placeholder-session";

  const result = parseProjectStoreStateWithMigration(legacy);
  const document = result.state.documents[0];

  assert.equal(result.was_migrated, true);
  assert.equal(document.format_version, SESSION_DOCUMENT_FORMAT_VERSION);
  assert.equal(document.input_draft, "");
  assert.equal(document.timeline[0].content, "Keep this session");
  assert.deepEqual(
    result.state.projects[0].new_chat_model,
    createDefaultModelSelection(),
  );
  assert.deepEqual(
    result.state.sessions[0].selected_model,
    createDefaultModelSelection(),
  );
});

test("schema-v2 migration adds command defaults and migrates its document", () => {
  const draft = createTranscriptState();
  draft.schema_version = 2;
  draft.projects[0].new_chat_draft = "new chat draft";
  draft.documents[0].input_draft = "session draft";
  delete draft.projects[0].new_chat_model;
  delete draft.sessions[0].selected_model;

  const result = parseProjectStoreStateWithMigration(draft);

  assert.equal(result.was_migrated, true);
  assert.equal(result.state.schema_version, 4);
  assert.deepEqual(
    result.state.projects[0].new_chat_model,
    createDefaultModelSelection(),
  );
  assert.deepEqual(
    result.state.sessions[0].selected_model,
    createDefaultModelSelection(),
  );
  assert.equal(result.state.projects[0].new_chat_reasoning_effort, "default");
  assert.equal(result.state.sessions[0].reasoning_effort, "default");
  assert.equal(result.state.projects[0].new_chat_draft, "new chat draft");
  assert.equal(result.state.documents[0].input_draft, "session draft");
  assert.equal(
    result.state.documents[0].format_version,
    SESSION_DOCUMENT_FORMAT_VERSION,
  );
});

test("schema-v3 migration adds reasoning effort defaults", () => {
  const draft = createState(1);
  draft.schema_version = 3;
  delete draft.projects[0].new_chat_reasoning_effort;
  delete draft.sessions[0].reasoning_effort;

  const result = parseProjectStoreStateWithMigration(draft);

  assert.equal(result.was_migrated, true);
  assert.equal(result.state.schema_version, 4);
  assert.equal(result.state.projects[0].new_chat_reasoning_effort, "default");
  assert.equal(result.state.sessions[0].reasoning_effort, "default");
});

test("project store rejects broken timeline and ownership invariants", () => {
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

  const duplicateBlock = createState(1);
  duplicateBlock.documents[0].timeline[1].blocks.push({
    ...duplicateBlock.documents[0].timeline[1].blocks[0],
  });
  assert.throws(
    () => parseProjectStoreState(duplicateBlock),
    /Duplicate assistant block_id/,
  );

  const invalidTimestamp = createState(1);
  invalidTimestamp.documents[0].timeline[0].created_at = "not-a-date";
  assert.throws(
    () => parseProjectStoreState(invalidTimestamp),
    /valid canonical ISO timestamp/,
  );

  const persistedPlaceholder = createState(1);
  persistedPlaceholder.sessions[0].title = "New chat";
  persistedPlaceholder.documents[0].timeline = [];
  assert.throws(
    () => parseProjectStoreState(persistedPlaceholder),
    /Unsubmitted new chats must not be persisted/,
  );
});

test("v4 parser drops retired redundant document fields", () => {
  const state = createState(1);
  const document = state.documents[0];
  document.messages = [];
  document.activities = [];
  document.agent_messages = [];

  const parsed = parseProjectStoreState(state);
  assert.equal("messages" in parsed.documents[0], false);
  assert.equal("activities" in parsed.documents[0], false);
  assert.equal("agent_messages" in parsed.documents[0], false);
});

test("project draft writes preserve exact text and advance revision", async () => {
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
  assert.equal(loaded.state_revision, 2);
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
  assert.equal(loaded.projects[0].new_chat_draft, "existing project draft");
  assert.equal(loaded.documents[0].input_draft, "  exact session draft\n");
  assert.equal(loaded.documents[1].input_draft, "second draft");
});

test("draft writes reject missing and cross-project targets", async () => {
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
    new_chat_reasoning_effort: "default",
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

function createState(stateRevision) {
  return {
    schema_version: 4,
    state_revision: stateRevision,
    active_project_id: "project-1",
    active_session_id: "session-1",
    projects: [createProjectRecord("session-1")],
    sessions: [createSessionRecord("session-1", "First chat")],
    documents: [createSessionDocument("session-1")],
  };
}

function createVirtualState(stateRevision) {
  return {
    schema_version: 4,
    state_revision: stateRevision,
    active_project_id: "project-1",
    active_session_id: null,
    projects: [createProjectRecord(null)],
    sessions: [],
    documents: [],
  };
}

function createProjectRecord(lastSessionId) {
  return {
    project_id: "project-1",
    name: "Local workspace",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    last_session_id: lastSessionId,
    new_chat_draft: "",
    new_chat_model: createDefaultModelSelection(),
    new_chat_reasoning_effort: "default",
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
    reasoning_effort: "default",
  };
}

function createSessionDocument(sessionId, inputDraft = "") {
  return {
    format_version: SESSION_DOCUMENT_FORMAT_VERSION,
    session_id: sessionId,
    project_id: "project-1",
    input_draft: inputDraft,
    timeline: [
      {
        type: "user_message",
        entry_id: `${sessionId}:user`,
        run_id: `${sessionId}:run`,
        created_at: TIMESTAMP,
        content: "Hello",
      },
      {
        type: "assistant_message",
        entry_id: `${sessionId}:assistant`,
        run_id: `${sessionId}:run`,
        created_at: TIMESTAMP,
        status: "complete",
        api: "mock",
        provider: "researchbox",
        model: "researchbox-mock",
        usage: emptyUsage(),
        stop_reason: "stop",
        blocks: [
          {
            type: "assistant_text",
            block_id: `${sessionId}:text`,
            text: "Done.",
          },
        ],
      },
    ],
  };
}

function createVersionThreeFileChangeState(toolName, changeKind) {
  const state = createState(1);
  const toolCallId = "legacy-change";
  const runId = "session-1:legacy-run";
  state.documents[0] = {
    format_version: 3,
    session_id: "session-1",
    project_id: "project-1",
    input_draft: "keep this draft",
    timeline: [
      {
        type: "user_message",
        entry_id: "legacy-user",
        run_id: runId,
        created_at: TIMESTAMP,
        content: "Change the note",
      },
      {
        type: "assistant_message",
        entry_id: "legacy-assistant",
        run_id: runId,
        created_at: TIMESTAMP,
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
            tool_call_id: toolCallId,
            tool_name: toolName,
            arguments: { path: "/notes/note.md" },
          },
        ],
      },
      {
        type: "tool_result",
        entry_id: "legacy-result",
        run_id: runId,
        created_at: TIMESTAMP,
        tool_call_block_id: "legacy-tool-block",
        tool_call_id: toolCallId,
        tool_name: toolName,
        content: '{"path":"/notes/note.md"}',
        is_error: false,
        summary: `${changeKind} note`,
        file_change: {
          change_id: "legacy-change-receipt",
          tool_call_id: toolCallId,
          path: "/notes/note.md",
          change_kind: changeKind,
          additions: changeKind === "deleted" ? 0 : 1,
          deletions: changeKind === "created" ? 0 : 1,
          byte_size: changeKind === "deleted" ? 0 : 6,
        },
      },
    ],
  };
  return state;
}

function createTranscriptState() {
  const state = createState(4);
  state.documents[0] = {
    format_version: 2,
    session_id: "session-1",
    project_id: "project-1",
    input_draft: "",
    messages: [
      createLegacyMessage("legacy-user", "user", "Create a note"),
      createLegacyMessage(
        "legacy-assistant",
        "assistant",
        "I’ll create it.Done.",
      ),
    ],
    activities: [createActivity()],
    agent_messages: [
      {
        role: "user",
        content: "Create a note",
        timestamp: TIMESTAMP_MS,
      },
      createStoredAssistant({
        content: [
          {
            type: "thinking",
            thinking: "I should write the note.",
            thinking_signature: "opaque-thinking",
            redacted: false,
          },
          {
            type: "text",
            text: "I’ll create it.",
            text_signature: "opaque-text",
          },
          {
            type: "tool_call",
            id: "write-note",
            name: "write_file",
            arguments: {
              path: "/notes/note.md",
              content: "# Note",
            },
            thought_signature: "opaque-thought",
          },
        ],
        stop_reason: "toolUse",
        timestamp: TIMESTAMP_MS + 1,
      }),
      {
        role: "tool_result",
        tool_call_id: "write-note",
        tool_name: "write_file",
        content: [{ type: "text", text: '{"path":"/notes/note.md"}' }],
        is_error: false,
        timestamp: TIMESTAMP_MS + 2,
      },
      createStoredAssistant({
        content: [{ type: "text", text: "Done." }],
        timestamp: TIMESTAMP_MS + 3,
      }),
    ],
  };
  return state;
}

function createStoredAssistant(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "mock",
    provider: "researchbox",
    model: "researchbox-mock",
    response_model: "researchbox-mock-2026-07",
    response_id: "response-1",
    usage: {
      input: 10,
      output: 8,
      cache_read: 2,
      cache_write: 0,
      total_tokens: 18,
      cost: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total: 0,
      },
    },
    stop_reason: "stop",
    timestamp: TIMESTAMP_MS,
    ...overrides,
  };
}

function createLegacyMessage(id, role, content) {
  return {
    id,
    role,
    content,
    created_at: TIMESTAMP,
    status: "complete",
  };
}

function createActivity() {
  return {
    activity_id: "activity-1",
    tool_call_id: "write-note",
    message_id: "legacy-assistant",
    tool_name: "write_file",
    label: "Writing /notes/note.md",
    status: "complete",
    summary: "Created · +1 −0",
    file_change: createFileChange(),
  };
}

function createFileChange() {
  return {
    change_id: "change-1",
    tool_call_id: "write-note",
    tool_name: "write_file",
    path: "/notes/note.md",
    change_kind: "created",
    additions: 1,
    deletions: 0,
    byte_size: 6,
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
    sessions: [
      {
        session_id: "placeholder-session",
        project_id: "project-1",
        title: "New chat",
        title_is_custom: false,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      },
    ],
    documents: [
      {
        format_version: 1,
        session_id: "placeholder-session",
        project_id: "project-1",
        messages: [],
        activities: [],
        agent_messages: [],
      },
    ],
  };
}

function createDefaultModelSelection() {
  return {
    provider_id: "researchbox",
    model_id: "researchbox-mock",
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
