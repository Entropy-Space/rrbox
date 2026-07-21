import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  createCommand,
  parseCoreEvent,
  parseViewerCommand,
} from "../src/index.ts";

test("round-trips every protocol-v2 management command", () => {
  const commands = [
    createCommand("bootstrap", {}),
    createCommand("project_create", { name: "Docs" }),
    createCommand("project_update", { project_id: "p1", name: "Product" }),
    createCommand("project_delete", { project_id: "p1" }),
    createCommand("project_select", { project_id: "p1" }),
    createCommand("session_create", { project_id: "p1" }),
    createCommand("session_create", { project_id: "p1", title: "Notes" }),
    createCommand("session_update", {
      project_id: "p1",
      session_id: "s1",
      title: "Renamed",
    }),
    createCommand("session_delete", { project_id: "p1", session_id: "s1" }),
    createCommand("session_select", { project_id: "p1", session_id: "s1" }),
    createCommand("prompt", {
      project_id: "p1",
      session_id: "s1",
      text: "hello",
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

test("validates authoritative state snapshots", () => {
  const event = parseCoreEvent({
    protocol_version: PROTOCOL_VERSION,
    event_id: "event-1",
    request_id: "request-1",
    type: "ready",
    payload: { state: createState() },
  });

  assert.equal(event.type, "ready");
  assert.equal(event.payload.state.active_project_id, "project-1");
  assert.equal(event.payload.state.sessions[0]?.message_count, 0);
  assert.equal(event.payload.state.files[0]?.path, "/README.md");
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
    coreEvent("ready", { state: createState() }),
    coreEvent("state_snapshot", { state: createState() }, "request-state"),
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
    coreEvent("error", {
      code: "agent_run_failed",
      message: "Provider failed",
      ...scope,
    }),
  ];

  for (const event of events) assert.deepEqual(parseCoreEvent(event), event);
});

test("requires request correlation for filesystem results and errors", () => {
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("files_snapshot", {
          project_id: "project-1",
          path: "/",
          files: [],
        }),
      ),
    /require request_id/,
  );
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

test("rejects malformed nested state and missing command scope", () => {
  assert.throws(
    () =>
      parseCoreEvent({
        protocol_version: PROTOCOL_VERSION,
        event_id: "event-1",
        type: "ready",
        payload: {
          state: {
            ...createState(),
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
  const mismatched = createState();
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

function createState() {
  return {
    state_revision: 1,
    projects: [
      {
        project_id: "project-1",
        name: "Local workspace",
        created_at: "2026-07-22T00:00:00.000Z",
        updated_at: "2026-07-22T00:00:00.000Z",
      },
    ],
    sessions: [
      {
        session_id: "session-1",
        project_id: "project-1",
        title: "New chat",
        created_at: "2026-07-22T00:00:00.000Z",
        updated_at: "2026-07-22T00:00:00.000Z",
        message_count: 0,
      },
    ],
    active_project_id: "project-1",
    active_session_id: "session-1",
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

function coreEvent(type, payload, requestId) {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: `event-${crypto.randomUUID()}`,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    type,
    payload,
  };
}
