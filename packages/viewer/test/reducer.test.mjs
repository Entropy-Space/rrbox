import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@researchbox/protocol";
import {
  coreReducer,
  initialAgentSessionState,
} from "../src/use-agent-session.ts";

test("viewer applies authoritative snapshots and ignores stale session events", () => {
  const ready = event("ready", { state: snapshot("p1", "s1", 3) });
  let state = coreReducer(initialAgentSessionState, ready);
  assert.equal(state.active_session_id, "s1");

  state = coreReducer(
    state,
    event("message_added", {
      project_id: "p2",
      session_id: "s2",
      message: chatMessage("late"),
    }),
  );
  assert.deepEqual(state.messages, []);

  const switched = snapshot("p2", "s2", 4);
  switched.messages = [chatMessage("current")];
  state = coreReducer(state, event("state_snapshot", { state: switched }));
  assert.equal(state.active_project_id, "p2");
  assert.equal(state.messages[0].id, "current");
  assert.equal(state.current_path, "/");
  assert.equal(state.selected_file, null);

  state = coreReducer(
    state,
    event("state_snapshot", { state: snapshot("p1", "s1", 2) }),
  );
  assert.equal(state.active_session_id, "s2");
});

test("tool activity is attached by tool call identity", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  const activity = {
    tool_call_id: "tool-1",
    message_id: "assistant-1",
    tool_name: "read_file",
    label: "Reading README",
    status: "running",
  };
  state = coreReducer(
    state,
    event("tool_activity", {
      project_id: "p1",
      session_id: "s1",
      activity,
    }),
  );
  state = coreReducer(
    state,
    event("tool_activity", {
      project_id: "p1",
      session_id: "s1",
      activity: { ...activity, status: "complete", summary: "Complete" },
    }),
  );
  assert.equal(state.activities.length, 1);
  assert.equal(state.activities[0].status, "complete");
});

test("filesystem responses are correlated to the latest request", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );

  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "list-old",
  });
  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "list-current",
  });
  state = coreReducer(
    state,
    event(
      "files_snapshot",
      {
        project_id: "p1",
        path: "/current",
        files: [fileEntry("current.txt")],
      },
      "list-current",
    ),
  );
  state = coreReducer(
    state,
    event(
      "files_snapshot",
      {
        project_id: "p1",
        path: "/old",
        files: [fileEntry("old.txt")],
      },
      "list-old",
    ),
  );
  assert.equal(state.current_path, "/current");
  assert.equal(state.files[0].name, "current.txt");

  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "read-old",
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "read-current",
  });
  state = coreReducer(
    state,
    event(
      "file_content",
      { project_id: "p1", path: "/current.txt", content: "current" },
      "read-current",
    ),
  );
  state = coreReducer(
    state,
    event(
      "file_content",
      { project_id: "p1", path: "/old.txt", content: "old" },
      "read-old",
    ),
  );
  assert.deepEqual(state.selected_file, {
    path: "/current.txt",
    content: "current",
  });
});

test("a newer file read invalidates an outstanding directory response", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "list-old",
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "read-current",
  });
  state = coreReducer(
    state,
    event(
      "files_snapshot",
      { project_id: "p1", path: "/old", files: [] },
      "list-old",
    ),
  );
  state = coreReducer(
    state,
    event(
      "file_content",
      { project_id: "p1", path: "/current.txt", content: "current" },
      "read-current",
    ),
  );

  assert.equal(state.current_path, "/");
  assert.equal(state.selected_file?.path, "/current.txt");
});

test("same-project snapshots preserve workspace navigation", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  state = {
    ...state,
    current_path: "/src",
    files: [fileEntry("agent.ts")],
    selected_file: { path: "/src/agent.ts", content: "source" },
    pending_fs_read_request_id: "read-pending",
  };

  const renamed = snapshot("p1", "s1", 2);
  renamed.projects[0].name = "Renamed";
  renamed.files = [fileEntry("README.md")];
  state = coreReducer(state, event("state_snapshot", { state: renamed }));

  assert.equal(state.current_path, "/src");
  assert.equal(state.files[0].name, "agent.ts");
  assert.equal(state.selected_file?.path, "/src/agent.ts");
  assert.equal(state.pending_fs_read_request_id, "read-pending");

  state = coreReducer(
    state,
    event("state_snapshot", { state: snapshot("p2", "s2", 3) }),
  );
  assert.equal(state.current_path, "/");
  assert.equal(state.selected_file, null);
  assert.equal(state.pending_fs_read_request_id, null);
});

function event(type, payload, requestId) {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    ...(requestId === undefined ? {} : { request_id: requestId }),
    type,
    payload,
  };
}

function snapshot(projectId, sessionId, revision) {
  const timestamp = "2026-07-22T00:00:00.000Z";
  return {
    state_revision: revision,
    projects: [
      {
        project_id: projectId,
        name: `Project ${projectId}`,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    sessions: [
      {
        session_id: sessionId,
        project_id: projectId,
        title: `Session ${sessionId}`,
        created_at: timestamp,
        updated_at: timestamp,
        message_count: 0,
      },
    ],
    active_project_id: projectId,
    active_session_id: sessionId,
    messages: [],
    activities: [],
    files: [],
    is_running: false,
  };
}

function chatMessage(id) {
  return {
    id,
    role: "assistant",
    content: "hello",
    created_at: "2026-07-22T00:00:00.000Z",
    status: "complete",
  };
}

function fileEntry(name) {
  return {
    name,
    path: `/${name}`,
    kind: "file",
    size: 1,
  };
}
