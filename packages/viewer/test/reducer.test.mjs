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
    event("timeline_entry_appended", {
      project_id: "p2",
      session_id: "s2",
      entry: assistantMessageEntry("late"),
    }),
  );
  assert.deepEqual(state.timeline, []);

  const switched = snapshot("p2", "s2", 4);
  switched.timeline = [
    userMessageEntry("current-user", "current-run"),
    assistantMessageEntry("current", {}, "current-run"),
  ];
  switched.sessions[0].message_count = 1;
  state = coreReducer(state, event("state_snapshot", { state: switched }));
  assert.equal(state.active_project_id, "p2");
  assert.equal(state.timeline[1].entry_id, "current");
  assert.equal(state.current_path, "/");
  assert.equal(state.selected_file, null);

  state = coreReducer(
    state,
    event("state_snapshot", { state: snapshot("p1", "s1", 2) }),
  );
  assert.equal(state.active_session_id, "s2");
});

test("authoritative snapshots update providers and the active model", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  assert.equal(state.providers[0]?.provider_id, "researchbox");
  assert.deepEqual(state.active_model, {
    provider_id: "researchbox",
    model_id: "researchbox-mock",
  });

  const changed = snapshot("p1", "s1", 2);
  changed.providers = [localOpenAiProvider()];
  changed.active_model = {
    provider_id: "local-openai",
    model_id: "gpt-5.4",
  };
  state = coreReducer(state, event("state_snapshot", { state: changed }));

  assert.deepEqual(state.providers, [localOpenAiProvider()]);
  assert.deepEqual(state.active_model, {
    provider_id: "local-openai",
    model_id: "gpt-5.4",
  });
});

test("catalog and lifecycle events stay independent from workspace state", () => {
  const catalogProviders = [mockProvider(), localOpenAiProvider()];
  let state = coreReducer(
    initialAgentSessionState,
    event("provider_catalog_snapshot", {
      catalog_revision: 2,
      providers: catalogProviders,
    }),
  );
  state = coreReducer(
    state,
    event("core_lifecycle", {
      phase: "waiting_for_writer",
      status_message: "Active in another tab.",
    }),
  );

  assert.deepEqual(state.providers, catalogProviders);
  assert.equal(state.catalog_revision, 2);
  assert.equal(state.is_ready, false);
  assert.deepEqual(state.active_model, { provider_id: "", model_id: "" });
  assert.deepEqual(state.projects, []);
  assert.equal(state.core_lifecycle, "waiting_for_writer");

  const olderWorkspace = snapshot("p1", null, 1, "keep draft");
  olderWorkspace.catalog_revision = 1;
  state = coreReducer(state, event("ready", { state: olderWorkspace }));
  assert.deepEqual(state.providers, catalogProviders);
  assert.equal(state.catalog_revision, 2);
  assert.equal(state.input_draft, "keep draft");
  assert.equal(state.core_lifecycle, "ready");

  state = coreReducer(
    state,
    event("provider_catalog_snapshot", {
      catalog_revision: 1,
      providers: [mockProvider()],
    }),
  );
  assert.deepEqual(state.providers, catalogProviders);
  assert.equal(state.input_draft, "keep draft");
});

test("transport failure disables a previously ready core", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1, "keep this draft") }),
  );
  state = coreReducer(state, {
    type: "prompt_submitted",
    request_id: "prompt-1",
    project_id: "p1",
    session_id: "s1",
    input_draft: "keep this draft",
    input_draft_generation: state.input_draft_generation,
  });
  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "files-1",
    path: "/",
    expected_workspace_revision: 0,
    request_kind: "navigation",
  });
  state = coreReducer(
    state,
    event("run_state", {
      project_id: "p1",
      session_id: "s1",
      is_running: true,
    }),
  );

  state = coreReducer(state, {
    type: "transport_failed",
    message: "The browser core stopped.",
  });

  assert.equal(state.core_lifecycle, "failed");
  assert.equal(state.is_ready, false);
  assert.equal(state.is_running, false);
  assert.equal(state.pending_prompt, null);
  assert.equal(state.pending_fs_list, null);
  assert.equal(state.input_draft, "keep this draft");
  assert.equal(state.error_message, "The browser core stopped.");
});

test("timeline entries and assistant blocks update in canonical array order", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  const assistant = assistantMessageEntry("assistant-1", {
    status: "streaming",
  });
  state = coreReducer(
    state,
    event("timeline_entry_appended", {
      project_id: "p1",
      session_id: "s1",
      entry: assistant,
    }),
  );
  state = coreReducer(
    state,
    event("assistant_block_appended", {
      project_id: "p1",
      session_id: "s1",
      entry_id: "assistant-1",
      block: {
        type: "reasoning",
        block_id: "reasoning-1",
        text: "Check",
      },
    }),
  );
  state = coreReducer(
    state,
    event("assistant_block_appended", {
      project_id: "p1",
      session_id: "s1",
      entry_id: "assistant-1",
      block: {
        type: "assistant_text",
        block_id: "text-1",
        text: "Hel",
      },
    }),
  );
  state = coreReducer(
    state,
    event("assistant_block_delta", {
      project_id: "p1",
      session_id: "s1",
      entry_id: "assistant-1",
      block_id: "text-1",
      block_type: "assistant_text",
      text_delta: "lo",
    }),
  );
  state = coreReducer(
    state,
    event("assistant_block_appended", {
      project_id: "p1",
      session_id: "s1",
      entry_id: "assistant-1",
      block: {
        type: "assistant_text",
        block_id: "text-1",
        text: "Hel",
      },
    }),
  );
  state = coreReducer(
    state,
    event("assistant_block_updated", {
      project_id: "p1",
      session_id: "s1",
      entry_id: "assistant-1",
      block: {
        type: "reasoning",
        block_id: "reasoning-1",
        text: "Checked",
      },
    }),
  );
  state = coreReducer(
    state,
    event("timeline_entry_updated", {
      project_id: "p1",
      session_id: "s1",
      entry: {
        ...state.timeline[0],
        status: "complete",
        stop_reason: "stop",
      },
    }),
  );

  assert.equal(state.timeline.length, 1);
  assert.equal(state.timeline[0].status, "complete");
  assert.deepEqual(
    state.timeline[0].blocks.map((block) => block.block_id),
    ["reasoning-1", "text-1"],
  );
  assert.equal(state.timeline[0].blocks[0].text, "Checked");
  assert.equal(state.timeline[0].blocks[1].text, "Hello");
});

test("duplicate append events are idempotent and preserve streamed state", () => {
  const original = assistantMessageEntry("assistant-1", {
    status: "streaming",
  });
  let state = {
    ...initialAgentSessionState,
    active_project_id: "p1",
    active_session_id: "s1",
    timeline: [
      userMessageEntry("user-1"),
      original,
      assistantMessageEntry("assistant-2"),
    ],
  };

  state = coreReducer(
    state,
    event("timeline_entry_appended", {
      project_id: "p1",
      session_id: "s1",
      entry: {
        ...original,
        status: "complete",
        stop_reason: "stop",
      },
    }),
  );

  assert.deepEqual(
    state.timeline.map((entry) => entry.entry_id),
    ["user-1", "assistant-1", "assistant-2"],
  );
  assert.equal(state.timeline[1].status, "streaming");
});

test("filesystem responses are correlated to the latest request", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );

  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "list-old",
    path: "/old",
    expected_workspace_revision: 0,
    request_kind: "navigation",
  });
  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "list-current",
    path: "/current",
    expected_workspace_revision: 0,
    request_kind: "navigation",
  });
  state = coreReducer(
    state,
    event(
      "files_snapshot",
      {
        project_id: "p1",
        path: "/current",
        workspace_revision: 0,
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
        workspace_revision: 0,
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
    path: "/old.txt",
    expected_workspace_revision: 0,
    request_kind: "navigation",
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "read-current",
    path: "/current.txt",
    expected_workspace_revision: 0,
    request_kind: "navigation",
  });
  state = coreReducer(
    state,
    event(
      "file_content",
      {
        project_id: "p1",
        path: "/current.txt",
        workspace_revision: 0,
        content: "current",
      },
      "read-current",
    ),
  );
  state = coreReducer(
    state,
    event(
      "file_content",
      {
        project_id: "p1",
        path: "/old.txt",
        workspace_revision: 0,
        content: "old",
      },
      "read-old",
    ),
  );
  assert.deepEqual(state.selected_file, {
    path: "/current.txt",
    content: "current",
  });
});

test("directory and file reads remain independently correlated", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "list-current",
    path: "/updated",
    expected_workspace_revision: 0,
    request_kind: "workspace_refresh",
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "read-current",
    path: "/current.txt",
    expected_workspace_revision: 0,
    request_kind: "navigation",
  });
  state = coreReducer(
    state,
    event(
      "files_snapshot",
      {
        project_id: "p1",
        path: "/updated",
        workspace_revision: 0,
        files: [],
      },
      "list-current",
    ),
  );
  state = coreReducer(
    state,
    event(
      "file_content",
      {
        project_id: "p1",
        path: "/current.txt",
        workspace_revision: 0,
        content: "current",
      },
      "read-current",
    ),
  );

  assert.equal(state.current_path, "/updated");
  assert.equal(state.selected_file?.path, "/current.txt");
});

test("a foreground file read supersedes an older foreground directory request", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "directory-first",
    path: "/old-directory",
    expected_workspace_revision: 0,
    request_kind: "navigation",
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "file-latest",
    path: "/latest.txt",
    expected_workspace_revision: 0,
    request_kind: "navigation",
  });

  assert.equal(state.pending_fs_list, null);
  state = coreReducer(
    state,
    event(
      "file_content",
      {
        project_id: "p1",
        path: "/latest.txt",
        workspace_revision: 0,
        content: "latest",
      },
      "file-latest",
    ),
  );
  state = coreReducer(
    state,
    event(
      "files_snapshot",
      {
        project_id: "p1",
        path: "/old-directory",
        workspace_revision: 0,
        files: [],
      },
      "directory-first",
    ),
  );

  assert.equal(state.current_path, "/");
  assert.deepEqual(state.selected_file, {
    path: "/latest.txt",
    content: "latest",
  });
});

test("workspace changes invalidate stale reads and preserve visible content while refreshing", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  state = {
    ...state,
    current_path: "/src",
    files: [fileEntry("agent.ts", "/src/agent.ts")],
    selected_file: { path: "/src/agent.ts", content: "before" },
  };
  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "list-before-change",
    path: "/src",
    expected_workspace_revision: 0,
    request_kind: "workspace_refresh",
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "read-before-change",
    path: "/src/agent.ts",
    expected_workspace_revision: 0,
    request_kind: "workspace_refresh",
  });

  state = coreReducer(
    state,
    event("workspace_changed", {
      project_id: "p1",
      session_id: "s1",
      workspace_revision: 1,
      change: fileChange("/src/agent.ts"),
    }),
  );

  assert.equal(state.workspace_revision, 1);
  assert.equal(state.pending_fs_list, null);
  assert.equal(state.pending_fs_read, null);
  assert.deepEqual(state.selected_file, {
    path: "/src/agent.ts",
    content: "before",
  });
  assert.deepEqual(state.pending_workspace_refresh, {
    workspace_revision: 1,
    changed_paths: ["/src/agent.ts"],
  });

  state = coreReducer(
    state,
    event(
      "files_snapshot",
      {
        project_id: "p1",
        path: "/src",
        workspace_revision: 0,
        files: [],
      },
      "list-before-change",
    ),
  );
  assert.equal(state.files[0].name, "agent.ts");

  state = coreReducer(state, {
    type: "workspace_refresh_started",
    workspace_revision: 1,
  });
  state = coreReducer(state, {
    type: "fs_list_requested",
    request_id: "list-after-change",
    path: "/src",
    expected_workspace_revision: 1,
    request_kind: "workspace_refresh",
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "read-after-change",
    path: "/src/agent.ts",
    expected_workspace_revision: 1,
    request_kind: "workspace_refresh",
  });
  assert.equal(state.selected_file?.content, "before");

  state = coreReducer(
    state,
    event(
      "files_snapshot",
      {
        project_id: "p1",
        path: "/src",
        workspace_revision: 1,
        files: [fileEntry("agent.ts", "/src/agent.ts", 24)],
      },
      "list-after-change",
    ),
  );
  state = coreReducer(
    state,
    event(
      "file_content",
      {
        project_id: "p1",
        path: "/src/agent.ts",
        workspace_revision: 1,
        content: "after",
      },
      "read-after-change",
    ),
  );

  assert.equal(state.files[0].size, 24);
  assert.equal(state.selected_file?.content, "after");
  assert.equal(state.pending_workspace_refresh, null);
});

test("a newer workspace change carries forward an invalidated selected-file refresh", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1) }),
  );
  state = {
    ...state,
    selected_file: { path: "/src/selected.ts", content: "before" },
  };
  state = coreReducer(
    state,
    event("workspace_changed", {
      project_id: "p1",
      session_id: "s1",
      workspace_revision: 1,
      change: fileChange("/src/selected.ts"),
    }),
  );
  state = coreReducer(state, {
    type: "workspace_refresh_started",
    workspace_revision: 1,
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "selected-revision-1",
    path: "/src/selected.ts",
    expected_workspace_revision: 1,
    request_kind: "workspace_refresh",
  });

  state = coreReducer(
    state,
    event("workspace_changed", {
      project_id: "p1",
      session_id: "s1",
      workspace_revision: 2,
      change: fileChange("/src/other.ts"),
    }),
  );

  assert.equal(state.pending_fs_read, null);
  assert.deepEqual(state.pending_workspace_refresh, {
    workspace_revision: 2,
    changed_paths: ["/src/selected.ts", "/src/other.ts"],
  });
  state = coreReducer(
    state,
    event(
      "file_content",
      {
        project_id: "p1",
        path: "/src/selected.ts",
        workspace_revision: 1,
        content: "stale",
      },
      "selected-revision-1",
    ),
  );
  assert.equal(state.selected_file?.content, "before");

  state = coreReducer(state, {
    type: "workspace_refresh_started",
    workspace_revision: 2,
  });
  state = coreReducer(state, {
    type: "fs_read_requested",
    request_id: "selected-revision-2",
    path: "/src/selected.ts",
    expected_workspace_revision: 2,
    request_kind: "workspace_refresh",
  });
  state = coreReducer(
    state,
    event(
      "file_content",
      {
        project_id: "p1",
        path: "/src/selected.ts",
        workspace_revision: 2,
        content: "after",
      },
      "selected-revision-2",
    ),
  );

  assert.equal(state.selected_file?.content, "after");
});

test("equal and older same-project snapshots preserve workspace navigation", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1, "", 2) }),
  );
  state = {
    ...state,
    current_path: "/src",
    files: [fileEntry("agent.ts")],
    selected_file: { path: "/src/agent.ts", content: "source" },
    pending_fs_read: {
      request_id: "read-pending",
      path: "/src/agent.ts",
      expected_workspace_revision: 2,
      request_kind: "workspace_refresh",
    },
  };

  const equalRevision = snapshot("p1", "s1", 2, "", 2);
  equalRevision.projects[0].name = "Renamed";
  equalRevision.files = [fileEntry("README.md")];
  state = coreReducer(
    state,
    event("state_snapshot", { state: equalRevision }),
  );

  assert.equal(state.current_path, "/src");
  assert.equal(state.files[0].name, "agent.ts");
  assert.equal(state.selected_file?.path, "/src/agent.ts");
  assert.equal(state.pending_fs_read?.request_id, "read-pending");

  const renamed = snapshot("p1", "s1", 3, "", 1);
  renamed.projects[0].name = "Renamed";
  renamed.files = [fileEntry("README.md")];
  state = coreReducer(state, event("state_snapshot", { state: renamed }));

  assert.equal(state.current_path, "/src");
  assert.equal(state.files[0].name, "agent.ts");
  assert.equal(state.selected_file?.path, "/src/agent.ts");
  assert.equal(state.pending_fs_read?.request_id, "read-pending");

  state = coreReducer(
    state,
    event("state_snapshot", { state: snapshot("p2", "s2", 3) }),
  );
  assert.equal(state.current_path, "/");
  assert.equal(state.selected_file, null);
  assert.equal(state.pending_fs_read, null);
});

test("a newer same-project snapshot replaces stale workspace navigation", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1, "", 1) }),
  );
  state = {
    ...state,
    current_path: "/src",
    files: [fileEntry("agent.ts")],
    selected_file: { path: "/src/agent.ts", content: "stale source" },
    pending_fs_list: {
      request_id: "list-pending",
      path: "/src",
      expected_workspace_revision: 1,
      request_kind: "workspace_refresh",
    },
    pending_fs_read: {
      request_id: "read-pending",
      path: "/src/agent.ts",
      expected_workspace_revision: 1,
      request_kind: "workspace_refresh",
    },
    pending_workspace_refresh: {
      workspace_revision: 1,
      changed_paths: ["/src/agent.ts"],
    },
  };

  const authoritative = snapshot("p1", "s1", 2, "", 2);
  authoritative.files = [fileEntry("README.md")];
  state = coreReducer(
    state,
    event("state_snapshot", { state: authoritative }),
  );

  assert.equal(state.workspace_revision, 2);
  assert.equal(state.current_path, "/");
  assert.equal(state.files[0].name, "README.md");
  assert.equal(state.selected_file, null);
  assert.equal(state.pending_fs_list, null);
  assert.equal(state.pending_fs_read, null);
  assert.equal(state.pending_workspace_refresh, null);
});

test("draft acknowledgements are scoped and only confirm the latest exact value", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", null, 1, "saved draft") }),
  );

  state = coreReducer(state, {
    type: "input_draft_changed",
    request_id: "draft-old",
    project_id: "p1",
    session_id: null,
    input_draft: "first",
  });
  state = coreReducer(state, {
    type: "input_draft_changed",
    request_id: "draft-current",
    project_id: "p1",
    session_id: null,
    input_draft: "  second draft\n",
  });
  state = coreReducer(
    state,
    event(
      "input_draft_saved",
      { project_id: "p1", session_id: null, input_draft: "first" },
      "draft-old",
    ),
  );

  assert.equal(state.input_draft, "  second draft\n");
  assert.equal(state.pending_input_draft_request_id, "draft-current");

  state = coreReducer(
    state,
    event(
      "input_draft_saved",
      { project_id: "p1", session_id: null, input_draft: "first" },
      "draft-current",
    ),
  );
  assert.equal(state.pending_input_draft_request_id, "draft-current");

  state = coreReducer(
    state,
    event(
      "input_draft_saved",
      {
        project_id: "p1",
        session_id: null,
        input_draft: "  second draft\n",
      },
      "draft-current",
    ),
  );
  assert.equal(state.pending_input_draft_request_id, null);
});

test("a failed draft save stays local and is scheduled for retry", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1, "saved") }),
  );
  state = coreReducer(state, {
    type: "input_draft_changed",
    request_id: "draft-failed",
    project_id: "p1",
    session_id: "s1",
    input_draft: "keep this locally",
  });
  state = coreReducer(
    state,
    event(
      "error",
      {
        code: "persistence_failed",
        message: "Disk unavailable",
        project_id: "p1",
        session_id: "s1",
      },
      "draft-failed",
    ),
  );

  assert.equal(state.input_draft, "keep this locally");
  assert.equal(state.pending_input_draft_request_id, null);
  assert.equal(state.input_draft_needs_sync, true);
  assert.equal(state.input_draft_retry_count, 1);

  state = coreReducer(state, {
    type: "input_draft_sync_started",
    request_id: "draft-retry",
    project_id: "p1",
    session_id: "s1",
    input_draft: "keep this locally",
  });
  state = coreReducer(
    state,
    event(
      "input_draft_saved",
      {
        project_id: "p1",
        session_id: "s1",
        input_draft: "keep this locally",
      },
      "draft-retry",
    ),
  );
  assert.equal(state.input_draft_needs_sync, false);
  assert.equal(state.pending_input_draft_request_id, null);
  assert.equal(state.input_draft_retry_count, 0);
});

test("switching between virtual and persisted chats never leaks drafts", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", null, 1, "project draft") }),
  );
  state = coreReducer(state, {
    type: "input_draft_changed",
    request_id: "project-draft",
    project_id: "p1",
    session_id: null,
    input_draft: "unsaved project draft",
  });

  state = coreReducer(
    state,
    event("state_snapshot", {
      state: snapshot("p1", "s1", 2, "session draft"),
    }),
  );
  assert.equal(state.active_session_id, "s1");
  assert.equal(state.input_draft, "session draft");
  assert.equal(state.pending_input_draft_request_id, null);

  state = coreReducer(
    state,
    event("state_snapshot", {
      state: snapshot("p1", null, 3, "project draft"),
    }),
  );
  assert.equal(state.active_session_id, null);
  assert.equal(state.input_draft, "project draft");
});

test("an accepted prompt clears only the draft version that was submitted", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", "s1", 1, "first prompt") }),
  );
  state = coreReducer(state, {
    type: "prompt_submitted",
    request_id: "prompt-1",
    project_id: "p1",
    session_id: "s1",
    input_draft: "first prompt",
    input_draft_generation: state.input_draft_generation,
  });
  state = coreReducer(
    state,
    event(
      "timeline_entry_appended",
      {
        project_id: "p1",
        session_id: "s1",
        entry: userMessageEntry("user-1"),
      },
      "prompt-1",
    ),
  );
  assert.equal(state.input_draft, "");
  assert.equal(state.pending_prompt, null);

  state = coreReducer(state, {
    type: "input_draft_changed",
    request_id: "draft-2",
    project_id: "p1",
    session_id: "s1",
    input_draft: "second prompt",
  });
  state = coreReducer(state, {
    type: "prompt_submitted",
    request_id: "prompt-2",
    project_id: "p1",
    session_id: "s1",
    input_draft: "second prompt",
    input_draft_generation: state.input_draft_generation,
  });
  state = coreReducer(state, {
    type: "input_draft_changed",
    request_id: "next-draft",
    project_id: "p1",
    session_id: "s1",
    input_draft: "typed after submit",
  });
  state = coreReducer(
    state,
    event(
      "timeline_entry_appended",
      {
        project_id: "p1",
        session_id: "s1",
        entry: userMessageEntry("user-2"),
      },
      "prompt-2",
    ),
  );
  assert.equal(state.input_draft, "typed after submit");
  assert.equal(state.pending_input_draft_request_id, "next-draft");
  assert.equal(state.pending_prompt, null);
});

test("a first prompt retargets text typed after submit to the created chat", () => {
  let state = coreReducer(
    initialAgentSessionState,
    event("ready", { state: snapshot("p1", null, 1, "first prompt") }),
  );
  state = coreReducer(state, {
    type: "prompt_submitted",
    request_id: "prompt-new-chat",
    project_id: "p1",
    session_id: null,
    input_draft: "first prompt",
    input_draft_generation: state.input_draft_generation,
  });
  state = coreReducer(state, {
    type: "input_draft_changed",
    request_id: "virtual-next-draft",
    project_id: "p1",
    session_id: null,
    input_draft: "next prompt",
  });
  state = coreReducer(
    state,
    event(
      "state_snapshot",
      { state: snapshot("p1", "s1", 2, "") },
      "prompt-new-chat",
    ),
  );

  assert.equal(state.active_session_id, "s1");
  assert.equal(state.input_draft, "next prompt");
  assert.equal(state.input_draft_needs_sync, true);
  assert.deepEqual(state.input_draft_cleanup_scope, {
    project_id: "p1",
    session_id: null,
  });
  assert.equal(state.pending_input_draft_request_id, null);
  assert.equal(state.pending_prompt, null);
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

function snapshot(
  projectId,
  sessionId,
  revision,
  inputDraft = "",
  workspaceRevision = 0,
) {
  const timestamp = "2026-07-22T00:00:00.000Z";
  return {
    state_revision: revision,
    catalog_revision: revision,
    workspace_revision: workspaceRevision,
    projects: [
      {
        project_id: projectId,
        name: `Project ${projectId}`,
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    sessions:
      sessionId === null
        ? []
        : [
            {
              session_id: sessionId,
              project_id: projectId,
              title: `Session ${sessionId}`,
              created_at: timestamp,
              updated_at: timestamp,
              message_count: 0,
            },
          ],
    providers: [mockProvider()],
    active_model: {
      provider_id: "researchbox",
      model_id: "researchbox-mock",
    },
    active_project_id: projectId,
    active_session_id: sessionId,
    input_draft: inputDraft,
    timeline: [],
    files: [],
    is_running: false,
  };
}

function mockProvider() {
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

function localOpenAiProvider() {
  return {
    provider_id: "local-openai",
    display_name: "OpenAI-compatible · localhost:4141",
    kind: "openai_compatible",
    availability: "ready",
    models: [
      {
        provider_id: "local-openai",
        model_id: "gpt-5.4",
        display_name: "GPT-5.4",
        availability: "ready",
      },
    ],
  };
}

function userMessageEntry(entryId, runId = "run-1") {
  return {
    type: "user_message",
    entry_id: entryId,
    run_id: runId,
    content: "hello",
    created_at: "2026-07-22T00:00:00.000Z",
  };
}

function assistantMessageEntry(
  entryId,
  overrides = {},
  runId = "run-1",
) {
  const status = overrides.status ?? "complete";
  return {
    type: "assistant_message",
    entry_id: entryId,
    run_id: runId,
    created_at: "2026-07-22T00:00:00.000Z",
    status,
    api: "mock",
    provider: "researchbox",
    model: "researchbox-mock",
    usage: {
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
    },
    ...(status === "complete" ? { stop_reason: "stop" } : {}),
    blocks: [],
    ...overrides,
  };
}

function fileEntry(name, path = `/${name}`, size = 1) {
  return {
    name,
    path,
    kind: "file",
    size,
  };
}

function fileChange(path) {
  return {
    change_id: "change-1",
    tool_call_id: "tool-1",
    path,
    change_kind: "updated",
    additions: 2,
    deletions: 1,
    byte_size: 24,
  };
}
