import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  createCommand,
  parseCoreEvent,
  parseViewerCommand,
} from "../src/index.ts";

test("round-trips every protocol-v5 command", () => {
  const commands = [
    createCommand("bootstrap", {}),
    createCommand("project_create", { name: "Docs" }),
    createCommand("project_update", { project_id: "p1", name: "Product" }),
    createCommand("project_delete", { project_id: "p1" }),
    createCommand("project_select", { project_id: "p1" }),
    createCommand("new_chat", { project_id: "p1" }),
    createCommand("model_select", {
      project_id: "p1",
      session_id: "s1",
      provider_id: "local-openai",
      model_id: "gpt-5.4",
    }),
    createCommand("provider_refresh", { provider_id: "local-openai" }),
    createCommand("session_update", {
      project_id: "p1",
      session_id: "s1",
      title: "Renamed",
    }),
    createCommand("session_delete", { project_id: "p1", session_id: "s1" }),
    createCommand("session_select", { project_id: "p1", session_id: "s1" }),
    createCommand("input_draft_update", {
      project_id: "p1",
      session_id: null,
      input_draft: "",
    }),
    createCommand("input_draft_update", {
      project_id: "p1",
      session_id: "s1",
      input_draft: "  unfinished message\n",
    }),
    createCommand("prompt", {
      project_id: "p1",
      session_id: null,
      text: "first message",
    }),
    createCommand("prompt", {
      project_id: "p1",
      session_id: "s1",
      text: "follow-up",
    }),
    createCommand("abort", { project_id: "p1", session_id: "s1" }),
    createCommand("fs_list", { project_id: "p1", path: "/" }),
    createCommand("fs_read", { project_id: "p1", path: "/README.md" }),
  ];

  for (const command of commands) {
    assert.equal(command.protocol_version, PROTOCOL_VERSION);
    assert.deepEqual(parseViewerCommand(command), command);
  }
});

test("rejects retired commands and older protocol versions", () => {
  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-1",
        type: "session_create",
        payload: { project_id: "project-1" },
      }),
    /Unknown command type: session_create/,
  );
  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: 2,
        request_id: "request-2",
        type: "bootstrap",
        payload: {},
      }),
    /Unsupported protocol version/,
  );
});

test("validates authoritative state snapshots with persisted sessions", () => {
  const event = parseCoreEvent({
    protocol_version: PROTOCOL_VERSION,
    event_id: "event-1",
    request_id: "request-1",
    type: "ready",
    payload: { state: createPersistedState() },
  });

  assert.equal(event.type, "ready");
  assert.equal(event.payload.state.active_project_id, "project-1");
  assert.equal(event.payload.state.active_session_id, "session-1");
  assert.equal(event.payload.state.input_draft, "draft reply");
  assert.equal(event.payload.state.providers[0]?.provider_id, "researchbox");
  assert.deepEqual(event.payload.state.active_model, {
    provider_id: "researchbox",
    model_id: "researchbox-mock",
  });
  assert.equal(event.payload.state.sessions[0]?.message_count, 0);
  assert.equal(event.payload.state.files[0]?.path, "/README.md");
});

test("accepts virtual new chat state and preserves its draft exactly", () => {
  const state = createVirtualState();
  const event = parseCoreEvent(
    coreEvent("state_snapshot", { state }, "request-new-chat"),
  );

  assert.equal(event.type, "state_snapshot");
  assert.equal(event.payload.state.active_session_id, null);
  assert.equal(event.payload.state.sessions.length, 0);
  assert.equal(event.payload.state.input_draft, "  unfinished message\n");
});

test("round-trips every core event variant", () => {
  const scope = { project_id: "project-1", session_id: "session-1" };
  const message = {
    id: "message-1",
    role: "assistant",
    content: "Hello",
    created_at: "2026-07-22T00:00:00.000Z",
    status: "complete",
  };
  const events = [
    coreEvent("core_lifecycle", {
      phase: "waiting_for_writer",
      status_message: "Active in another tab.",
    }),
    coreEvent("provider_catalog_snapshot", {
      catalog_revision: 2,
      providers: [createMockProvider()],
    }),
    coreEvent("ready", { state: createPersistedState() }),
    coreEvent(
      "state_snapshot",
      { state: createVirtualState() },
      "request-state",
    ),
    coreEvent("run_state", { ...scope, is_running: true }),
    coreEvent("message_added", { ...scope, message }),
    coreEvent("message_delta", {
      ...scope,
      message_id: "message-1",
      text_delta: "chunk",
    }),
    ...["complete", "aborted", "error"].map((status) =>
      coreEvent("message_finished", {
        ...scope,
        message_id: "message-1",
        status,
        ...(status === "error" ? { error_message: "Provider failed" } : {}),
      }),
    ),
    coreEvent("tool_activity", {
      ...scope,
      activity: {
        tool_call_id: "tool-1",
        message_id: "message-1",
        tool_name: "read_file",
        label: "Read README",
        status: "complete",
        summary: "Complete",
      },
    }),
    coreEvent(
      "files_snapshot",
      { project_id: "project-1", path: "/", files: [] },
      "request-list",
    ),
    coreEvent(
      "file_content",
      {
        project_id: "project-1",
        path: "/README.md",
        content: "# ResearchBox",
      },
      "request-read",
    ),
    coreEvent(
      "input_draft_saved",
      {
        project_id: "project-1",
        session_id: null,
        input_draft: "",
      },
      "request-new-draft",
    ),
    coreEvent(
      "input_draft_saved",
      {
        project_id: "project-1",
        session_id: "session-1",
        input_draft: "  next prompt\n",
      },
      "request-session-draft",
    ),
    coreEvent("error", {
      code: "agent_run_failed",
      message: "Provider failed",
      ...scope,
    }),
  ];

  for (const event of events) assert.deepEqual(parseCoreEvent(event), event);
});

test("validates independent lifecycle and provider catalog events", () => {
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("core_lifecycle", {
          phase: "querying_models",
        }),
      ),
    /Invalid core lifecycle phase/,
  );
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("provider_catalog_snapshot", {
          catalog_revision: 1,
          providers: [createMockProvider(), createMockProvider()],
        }),
      ),
    /Duplicate provider_id/,
  );
});

test("requires request correlation for filesystem and draft results", () => {
  const uncorrelatedEvents = [
    coreEvent("files_snapshot", {
      project_id: "project-1",
      path: "/",
      files: [],
    }),
    coreEvent("file_content", {
      project_id: "project-1",
      path: "/README.md",
      content: "",
    }),
    coreEvent("input_draft_saved", {
      project_id: "project-1",
      session_id: null,
      input_draft: "draft",
    }),
  ];

  for (const event of uncorrelatedEvents) {
    assert.throws(() => parseCoreEvent(event), /require request_id/);
  }
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("error", {
          code: "fs_read_failed",
          message: "Missing",
          project_id: "project-1",
        }),
      ),
    /require request_id/,
  );
});

test("requires explicit nullable session scope for drafts and prompts", () => {
  for (const command of [
    {
      type: "prompt",
      payload: { project_id: "project-1", text: "hello" },
    },
    {
      type: "input_draft_update",
      payload: { project_id: "project-1", input_draft: "hello" },
    },
  ]) {
    assert.throws(
      () =>
        parseViewerCommand({
          protocol_version: PROTOCOL_VERSION,
          request_id: "request-missing-session",
          ...command,
        }),
      /session_id must be null or a non-empty string/,
    );
  }

  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-empty-session",
        type: "prompt",
        payload: {
          project_id: "project-1",
          session_id: "",
          text: "hello",
        },
      }),
    /session_id must be null or a non-empty string/,
  );
});

test("rejects malformed nested state and mismatched active scope", () => {
  assert.throws(
    () =>
      parseCoreEvent({
        protocol_version: PROTOCOL_VERSION,
        event_id: "event-1",
        type: "ready",
        payload: {
          state: {
            ...createPersistedState(),
            activities: [
              {
                tool_call_id: "tool-1",
                tool_name: "read_file",
                label: "Read",
                status: "running",
              },
            ],
          },
        },
      }),
    /message_id must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-2",
        type: "prompt",
        payload: { session_id: "session-1", text: "hello" },
      }),
    /project_id must be a non-empty string/,
  );

  const mismatched = createPersistedState();
  mismatched.projects.push({
    ...mismatched.projects[0],
    project_id: "project-2",
    name: "Other",
  });
  mismatched.active_project_id = "project-2";
  assert.throws(
    () =>
      parseCoreEvent({
        protocol_version: PROTOCOL_VERSION,
        event_id: "event-3",
        type: "state_snapshot",
        payload: { state: mismatched },
      }),
    /Active session does not belong to active project/,
  );
});

test("validates provider inventories and the active model selection", () => {
  const unknownProvider = createPersistedState();
  unknownProvider.active_model = {
    provider_id: "missing-provider",
    model_id: "researchbox-mock",
  };
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("state_snapshot", { state: unknownProvider }),
      ),
    /active_model references an unknown provider_id/,
  );

  const unknownModel = createPersistedState();
  unknownModel.active_model = {
    provider_id: "researchbox",
    model_id: "missing-model",
  };
  assert.throws(
    () => parseCoreEvent(coreEvent("state_snapshot", { state: unknownModel })),
    /active_model references an unknown model_id/,
  );

  const mismatchedModelProvider = createPersistedState();
  mismatchedModelProvider.providers[0].models[0].provider_id = "local-openai";
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("state_snapshot", { state: mismatchedModelProvider }),
      ),
    /Model provider_id does not match its provider/,
  );

  const duplicateModel = createPersistedState();
  duplicateModel.providers[0].models.push({
    ...duplicateModel.providers[0].models[0],
  });
  assert.throws(
    () => parseCoreEvent(coreEvent("state_snapshot", { state: duplicateModel })),
    /Duplicate model_id/,
  );
});

test("rejects runtime state on virtual new chat", () => {
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("state_snapshot", {
          state: {
            ...createVirtualState(),
            messages: [
              {
                id: "message-1",
                role: "user",
                content: "hello",
                created_at: "2026-07-22T00:00:00.000Z",
                status: "complete",
              },
            ],
          },
        }),
      ),
    /Virtual new chat cannot contain messages or tool activities/,
  );
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("state_snapshot", {
          state: { ...createVirtualState(), is_running: true },
        }),
      ),
    /Virtual new chat cannot have an active run/,
  );
});

function createPersistedState() {
  return {
    state_revision: 1,
    catalog_revision: 1,
    projects: [createProject()],
    sessions: [
      {
        session_id: "session-1",
        project_id: "project-1",
        title: "Notes",
        created_at: "2026-07-22T00:00:00.000Z",
        updated_at: "2026-07-22T00:00:00.000Z",
        message_count: 0,
      },
    ],
    providers: [createMockProvider()],
    active_model: {
      provider_id: "researchbox",
      model_id: "researchbox-mock",
    },
    active_project_id: "project-1",
    active_session_id: "session-1",
    input_draft: "draft reply",
    messages: [],
    activities: [],
    files: [
      {
        name: "README.md",
        path: "/README.md",
        kind: "file",
        size: 12,
      },
    ],
    is_running: false,
  };
}

function createVirtualState() {
  return {
    state_revision: 1,
    catalog_revision: 1,
    projects: [createProject()],
    sessions: [],
    providers: [createMockProvider()],
    active_model: {
      provider_id: "researchbox",
      model_id: "researchbox-mock",
    },
    active_project_id: "project-1",
    active_session_id: null,
    input_draft: "  unfinished message\n",
    messages: [],
    activities: [],
    files: [],
    is_running: false,
  };
}

function createMockProvider() {
  return {
    provider_id: "researchbox",
    display_name: "ResearchBox",
    kind: "mock",
    availability: "ready",
    models: [
      {
        provider_id: "researchbox",
        model_id: "researchbox-mock",
        display_name: "ResearchBox Mock",
        availability: "ready",
      },
    ],
  };
}

function createProject() {
  return {
    project_id: "project-1",
    name: "Local workspace",
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
  };
}

function coreEvent(type, payload, requestId) {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: `event-${crypto.randomUUID()}`,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    type,
    payload,
  };
}
