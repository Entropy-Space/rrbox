import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  createCommand,
  parseCoreEvent,
  parseTimeline,
  parseViewerCommand,
} from "../src/index.ts";

test("round-trips every protocol-v8 command", () => {
  const commands = [
    createCommand("bootstrap", {}),
    createCommand("project_create", { name: "Docs" }),
    createCommand("project_import", {
      name: "Imported docs",
      files: [
        { path: "/README.md", content: "# Imported" },
        { path: "/empty.txt", content: "" },
      ],
    }),
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
    createCommand("workspace_export", { project_id: "p1" }),
    createCommand("workspace_export_cancel", {
      target_request_id: "export-request",
    }),
    createCommand("fs_list", { project_id: "p1", path: "/" }),
    createCommand("fs_read", { project_id: "p1", path: "/README.md" }),
  ];

  for (const command of commands) {
    assert.equal(command.protocol_version, PROTOCOL_VERSION);
    assert.deepEqual(parseViewerCommand(command), command);
  }
});

test("round-trips an ordered timeline with every block and entry type", () => {
  const timeline = createTimeline();

  assert.deepEqual(parseTimeline(timeline), timeline);
  assert.deepEqual(
    timeline.map((entry) => entry.type),
    [
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
    ],
  );
  assert.deepEqual(
    timeline[1].blocks.map((block) => block.type),
    ["reasoning", "assistant_text", "tool_call"],
  );
});

test("timeline order, run identity, and internal IDs are authoritative", () => {
  const noncontiguous = createTimeline();
  noncontiguous.push({
    ...createUserEntry("run-1"),
    entry_id: "user-repeated-run",
  });
  assert.throws(
    () => parseTimeline(noncontiguous),
    /run is not contiguous|exactly one user_message/,
  );

  const noUser = createTimeline().slice(1);
  assert.throws(
    () => parseTimeline(noUser),
    /run must start with a user_message/,
  );

  const duplicateUser = createTimeline();
  duplicateUser.splice(1, 0, {
    ...createUserEntry("run-1"),
    entry_id: "second-user",
  });
  assert.throws(
    () => parseTimeline(duplicateUser),
    /exactly one user_message/,
  );

  const duplicateEntry = createTimeline();
  duplicateEntry[1].entry_id = duplicateEntry[0].entry_id;
  assert.throws(
    () => parseTimeline(duplicateEntry),
    /Duplicate timeline entry_id/,
  );

  const duplicateBlock = createTimeline();
  duplicateBlock[3].blocks[0].block_id = "reasoning-1";
  assert.throws(
    () => parseTimeline(duplicateBlock),
    /Duplicate assistant block_id/,
  );
});

test("tool results require one earlier matching call in the same run", () => {
  const missing = createTimeline();
  missing[2].tool_call_block_id = "missing";
  assert.throws(
    () => parseTimeline(missing),
    /active assistant tool-call group/,
  );

  const mismatchedRawId = createTimeline();
  mismatchedRawId[2].tool_call_id = "other";
  delete mismatchedRawId[2].file_change;
  assert.throws(
    () => parseTimeline(mismatchedRawId),
    /identity must match/,
  );

  const mismatchedName = createTimeline();
  mismatchedName[2].tool_name = "read_file";
  assert.throws(
    () => parseTimeline(mismatchedName),
    /identity must match/,
  );

  const mismatchedRun = createTimeline();
  mismatchedRun[2].run_id = "run-2";
  assert.throws(
    () => parseTimeline(mismatchedRun),
    /run must start with a user_message/,
  );

  const duplicateResult = createTimeline();
  duplicateResult.splice(3, 0, {
    ...structuredClone(duplicateResult[2]),
    entry_id: "result-2",
  });
  assert.throws(
    () => parseTimeline(duplicateResult),
    /at most one tool result/,
  );
});

test("tool results stay adjacent to their assistant tool-call group", () => {
  const unresolvedTail = createTimeline().slice(0, 2);
  assert.deepEqual(parseTimeline(unresolvedTail), unresolvedTail);

  const interveningAssistant = createTimeline();
  interveningAssistant.splice(
    2,
    0,
    createAssistantEntry({
      entry_id: "intervening-assistant",
      blocks: [
        {
          type: "assistant_text",
          block_id: "intervening-text",
          text: "Still working.",
        },
      ],
    }),
  );
  assert.throws(
    () => parseTimeline(interveningAssistant),
    /followed immediately by their tool results/,
  );

  const nextRunBeforeResult = createTimeline();
  nextRunBeforeResult.splice(2, 0, {
    ...createUserEntry("run-2"),
    entry_id: "user-2",
  });
  assert.throws(
    () => parseTimeline(nextRunBeforeResult),
    /followed immediately by their tool results/,
  );
});

test("a partial tool-result group is valid only at timeline tail", () => {
  const timeline = createTimeline();
  timeline[1].blocks.push({
    type: "tool_call",
    block_id: "tool-block-2",
    tool_call_id: "tool-2",
    tool_name: "read_file",
    arguments: { path: "/README.md" },
  });
  const partialTail = timeline.slice(0, 3);
  assert.deepEqual(parseTimeline(partialTail), partialTail);

  partialTail.push(
    createAssistantEntry({
      entry_id: "assistant-after-partial-results",
      blocks: [
        {
          type: "assistant_text",
          block_id: "text-after-partial-results",
          text: "Continuing.",
        },
      ],
    }),
  );
  assert.throws(
    () => parseTimeline(partialTail),
    /followed immediately by their tool results/,
  );
});

test("provider tool-call IDs are unique within one assistant message", () => {
  const timeline = createTimeline().slice(0, 2);
  timeline[1].blocks.push({
    type: "tool_call",
    block_id: "tool-block-duplicate-raw-id",
    tool_call_id: "tool-1",
    tool_name: "read_file",
    arguments: { path: "/README.md" },
  });

  assert.throws(
    () => parseTimeline(timeline),
    /Duplicate tool_call_id in assistant message/,
  );
});

test("timeline timestamps must be canonical finite ISO timestamps", () => {
  const invalid = createTimeline();
  invalid[0].created_at = "not-a-date";
  assert.throws(
    () => parseTimeline(invalid),
    /valid canonical ISO timestamp/,
  );

  const noncanonical = createTimeline();
  noncanonical[0].created_at = "2026-07-22T00:00:00Z";
  assert.throws(
    () => parseTimeline(noncanonical),
    /valid canonical ISO timestamp/,
  );

  assert.deepEqual(parseTimeline(createTimeline()), createTimeline());
});

test("assistant status and stop reason remain consistent", () => {
  const streaming = createAssistantEntry({
    entry_id: "streaming",
    status: "streaming",
    blocks: [],
  });
  delete streaming.stop_reason;
  assert.deepEqual(parseTimeline([createUserEntry("run-1"), streaming]), [
    createUserEntry("run-1"),
    streaming,
  ]);

  for (const [status, stopReason] of [
    ["streaming", "stop"],
    ["complete", undefined],
    ["complete", "error"],
    ["aborted", "stop"],
    ["error", "aborted"],
  ]) {
    const invalid = createAssistantEntry({
      entry_id: `invalid-${status}-${stopReason}`,
      status,
      stop_reason: stopReason,
      blocks: [],
    });
    assert.throws(() =>
      parseTimeline([createUserEntry("run-1"), invalid]),
    );
  }
});

test("tool arguments must be JSON and are cloned by the parser", () => {
  const timeline = createTimeline();
  timeline[1].blocks[2].arguments = {
    path: "/README.md",
    nested: { enabled: true },
  };
  const parsed = parseTimeline(timeline);
  timeline[1].blocks[2].arguments.nested.enabled = false;
  assert.equal(parsed[1].blocks[2].arguments.nested.enabled, true);

  const invalid = createTimeline();
  invalid[1].blocks[2].arguments = { value: undefined };
  assert.throws(() => parseTimeline(invalid), /only JSON values/);
});

test("round-trips every normalized timeline core event", () => {
  const scope = { project_id: "project-1", session_id: "session-1" };
  const timeline = createTimeline();
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
    coreEvent("timeline_entry_appended", {
      ...scope,
      entry: timeline[0],
    }),
    coreEvent("assistant_block_appended", {
      ...scope,
      entry_id: "assistant-1",
      block: timeline[1].blocks[0],
    }),
    coreEvent("assistant_block_delta", {
      ...scope,
      entry_id: "assistant-1",
      block_id: "reasoning-1",
      block_type: "reasoning",
      text_delta: "chunk",
    }),
    coreEvent("timeline_entry_updated", {
      ...scope,
      entry: timeline[1],
    }),
    coreEvent("assistant_block_updated", {
      ...scope,
      entry_id: "assistant-1",
      block: timeline[1].blocks[2],
    }),
    coreEvent("workspace_changed", {
      ...scope,
      workspace_revision: 2,
      change: createFileChange(),
    }),
    coreEvent(
      "files_snapshot",
      {
        project_id: "project-1",
        path: "/",
        workspace_revision: 2,
        files: [],
      },
      "request-list",
    ),
    coreEvent(
      "file_content",
      {
        project_id: "project-1",
        path: "/README.md",
        workspace_revision: 2,
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
      "request-draft",
    ),
    coreEvent(
      "workspace_export_snapshot",
      {
        project_id: "project-1",
        project_name: "Project one",
        workspace_revision: 2,
        files: [
          { path: "/README.md", content: "# ResearchBox" },
          { path: "/empty.txt", content: "" },
        ],
      },
      "request-export",
    ),
    coreEvent("error", {
      code: "agent_run_failed",
      message: "Provider failed",
      ...scope,
    }),
  ];

  for (const event of events) assert.deepEqual(parseCoreEvent(event), event);
});

test("rejects retired message and activity events", () => {
  for (const type of [
    "message_added",
    "message_delta",
    "message_finished",
    "tool_activity",
  ]) {
    assert.throws(
      () =>
        parseCoreEvent(
          coreEvent(type, {
            project_id: "project-1",
            session_id: "session-1",
          }),
        ),
      new RegExp(`Unknown core event type: ${type}`),
    );
  }
});

test("validates timeline snapshots and user-prompt message counts", () => {
  const state = createPersistedState();
  const event = parseCoreEvent(coreEvent("ready", { state }));
  assert.equal(event.payload.state.timeline.length, 4);
  assert.equal(event.payload.state.sessions[0].message_count, 1);

  const mismatch = createPersistedState();
  mismatch.sessions[0].message_count = 2;
  assert.throws(
    () => parseCoreEvent(coreEvent("state_snapshot", { state: mismatch })),
    /message_count must equal its user prompt count/,
  );
});

test("virtual new chat requires an empty timeline and cannot run", () => {
  const valid = parseCoreEvent(
    coreEvent("state_snapshot", { state: createVirtualState() }),
  );
  assert.equal(valid.payload.state.active_session_id, null);
  assert.deepEqual(valid.payload.state.timeline, []);

  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("state_snapshot", {
          state: {
            ...createVirtualState(),
            timeline: [createUserEntry("run-1")],
          },
        }),
      ),
    /Virtual new chat cannot contain timeline entries/,
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

test("requires request correlation for filesystem and draft results", () => {
  for (const event of [
    coreEvent("files_snapshot", {
      project_id: "project-1",
      path: "/",
      workspace_revision: 0,
      files: [],
    }),
    coreEvent("file_content", {
      project_id: "project-1",
      path: "/README.md",
      workspace_revision: 0,
      content: "",
    }),
    coreEvent("input_draft_saved", {
      project_id: "project-1",
      session_id: null,
      input_draft: "draft",
    }),
    coreEvent("workspace_export_snapshot", {
      project_id: "project-1",
      project_name: "Project one",
      workspace_revision: 0,
      files: [],
    }),
  ]) {
    assert.throws(() => parseCoreEvent(event), /require request_id/);
  }
});

test("strictly parses JSON-only workspace transfer files", () => {
  const files = [
    { path: "/README.md", content: "# Imported" },
    { path: "/empty.txt", content: "" },
  ];
  const command = {
    protocol_version: PROTOCOL_VERSION,
    request_id: "request-import",
    type: "project_import",
    payload: {
      name: "Imported",
      files,
    },
  };
  const parsed = parseViewerCommand(command);
  files[0].content = "mutated";
  files.push({ path: "/later.txt", content: "later" });
  assert.deepEqual(parsed.payload.files, [
    { path: "/README.md", content: "# Imported" },
    { path: "/empty.txt", content: "" },
  ]);

  for (const invalidFiles of [
    [{ path: "/a.txt", content: "a", bytes: new Uint8Array([1]) }],
    [{ path: "/a.txt", content: new Uint8Array([1]) }],
    [
      { path: "/same.txt", content: "first" },
      { path: "/same.txt", content: "second" },
    ],
    [{ path: "", content: "empty path" }],
  ]) {
    assert.throws(
      () =>
        parseViewerCommand({
          protocol_version: PROTOCOL_VERSION,
          request_id: "request-invalid-import",
          type: "project_import",
          payload: { name: "Imported", files: invalidFiles },
        }),
      /Workspace transfer|Duplicate workspace|path must|content must|exactly|only JSON/,
    );
  }

  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-extra-export",
        type: "workspace_export",
        payload: { project_id: "project-1", archive_bytes: [1, 2, 3] },
      }),
    /workspace_export payload must contain exactly/,
  );
  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-invalid-cancel",
        type: "workspace_export_cancel",
        payload: {
          target_request_id: "request-export",
          project_id: "project-1",
        },
      }),
    /workspace_export_cancel payload must contain exactly/,
  );
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent(
          "workspace_export_snapshot",
          {
            project_id: "project-1",
            project_name: "Project one",
            workspace_revision: 0,
            files: [],
            archive_bytes: [1, 2, 3],
          },
          "request-export",
        ),
      ),
    /workspace_export_snapshot payload must contain exactly/,
  );
});

test("validates workspace change identity and numeric fields", () => {
  const timeline = createTimeline();
  timeline[2].file_change.tool_call_id = "different";
  assert.throws(
    () => parseTimeline(timeline),
    /file_change must match tool_call_id/,
  );

  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("workspace_changed", {
          project_id: "project-1",
          session_id: "session-1",
          workspace_revision: 1,
          change: { ...createFileChange(), additions: -1 },
        }),
      ),
    /additions must be a non-negative number/,
  );

  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("files_snapshot", {
          project_id: "project-1",
          path: "/",
          workspace_revision: Number.MAX_SAFE_INTEGER + 1,
          files: [],
        }, "filesystem-request"),
      ),
    /workspace_revision must be a safe integer/,
  );
});

test("validates provider inventories and active ownership", () => {
  const unknownProvider = createPersistedState();
  unknownProvider.active_model.provider_id = "missing";
  assert.throws(
    () =>
      parseCoreEvent(coreEvent("state_snapshot", { state: unknownProvider })),
    /unknown provider_id/,
  );

  const mismatched = createPersistedState();
  mismatched.projects.push({
    ...mismatched.projects[0],
    project_id: "project-2",
  });
  mismatched.active_project_id = "project-2";
  assert.throws(
    () => parseCoreEvent(coreEvent("state_snapshot", { state: mismatched })),
    /does not belong to active project/,
  );
});

test("rejects older protocol versions and missing nullable session scope", () => {
  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: 7,
        request_id: "request-old",
        type: "bootstrap",
        payload: {},
      }),
    /Unsupported protocol version/,
  );
  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-missing-session",
        type: "prompt",
        payload: { project_id: "project-1", text: "hello" },
      }),
    /session_id must be null or a non-empty string/,
  );
});

function createTimeline() {
  return [
    createUserEntry("run-1"),
    createAssistantEntry({
      entry_id: "assistant-1",
      blocks: [
        {
          type: "reasoning",
          block_id: "reasoning-1",
          text: "I should inspect the file.",
          thinking_signature: "opaque-thinking",
          redacted: false,
        },
        {
          type: "assistant_text",
          block_id: "text-1",
          text: "I’ll update it.",
          text_signature: "opaque-text",
        },
        {
          type: "tool_call",
          block_id: "tool-block-1",
          tool_call_id: "tool-1",
          tool_name: "write_file",
          arguments: { path: "/README.md", content: "# Updated" },
          thought_signature: "opaque-thought",
          label: "Writing /README.md",
        },
      ],
    }),
    {
      type: "tool_result",
      entry_id: "result-1",
      run_id: "run-1",
      created_at: "2026-07-22T00:00:02.000Z",
      tool_call_block_id: "tool-block-1",
      tool_call_id: "tool-1",
      tool_name: "write_file",
      content: '{"path":"/README.md"}',
      is_error: false,
      summary: "Updated · +1 −1",
      file_change: createFileChange(),
    },
    createAssistantEntry({
      entry_id: "assistant-2",
      created_at: "2026-07-22T00:00:03.000Z",
      blocks: [
        {
          type: "assistant_text",
          block_id: "text-2",
          text: "Done.",
        },
      ],
    }),
  ];
}

function createUserEntry(runId) {
  return {
    type: "user_message",
    entry_id: "user-1",
    run_id: runId,
    created_at: "2026-07-22T00:00:00.000Z",
    content: "Update the README",
  };
}

function createAssistantEntry(overrides = {}) {
  return {
    type: "assistant_message",
    entry_id: "assistant-default",
    run_id: "run-1",
    created_at: "2026-07-22T00:00:01.000Z",
    status: "complete",
    api: "openai-completions",
    provider: "local-openai",
    model: "gpt-5.4",
    response_model: "gpt-5.4-2026-07-01",
    response_id: "response-1",
    usage: createUsage(),
    stop_reason: "stop",
    blocks: [],
    ...overrides,
  };
}

function createUsage() {
  return {
    input: 10,
    output: 20,
    cache_read: 2,
    cache_write: 0,
    total_tokens: 32,
    cost: {
      input: 0.01,
      output: 0.02,
      cache_read: 0,
      cache_write: 0,
      total: 0.03,
    },
  };
}

function createPersistedState() {
  return {
    state_revision: 1,
    catalog_revision: 1,
    workspace_revision: 2,
    projects: [createProject()],
    sessions: [
      {
        session_id: "session-1",
        project_id: "project-1",
        title: "Notes",
        created_at: "2026-07-22T00:00:00.000Z",
        updated_at: "2026-07-22T00:00:00.000Z",
        message_count: 1,
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
    timeline: createTimeline(),
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
    workspace_revision: 0,
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
    timeline: [],
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

function createFileChange() {
  return {
    change_id: "change-1",
    tool_call_id: "tool-1",
    path: "/README.md",
    change_kind: "updated",
    additions: 2,
    deletions: 1,
    byte_size: 42,
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
