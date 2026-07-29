import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  SUMMARY_REVIEW_MAX_QUERY_LENGTH,
  createCommand,
  parseCoreEvent,
  parseTimeline,
  parseViewerCommand,
} from "../src/index.ts";

test("round-trips every protocol-v18 command", () => {
  const commands = [
    createCommand("bootstrap", {}),
    createCommand("bootstrap", {
      active_project_id: "p1",
      active_session_id: null,
    }),
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
    createCommand("summary_review_resolve", {
      project_id: "p1",
      session_id: "s1",
      interaction_id: "review-1",
      resolution: {
        decision: "approve",
        approved_text: "Approved summary",
        selected_section_ids: ["0"],
        feedback_text: "",
        summary_model: {
          provider_id: "local-openai",
          model_id: "gpt-5.4",
        },
        search_provider: null,
        query_text: "",
      },
    }),
    createCommand("workspace_export", { project_id: "p1" }),
    createCommand("workspace_export_cancel", {
      target_request_id: "export-request",
    }),
    createCommand("workspace_change_read", {
      project_id: "p1",
      change_id: "change-1",
    }),
    createCommand("workspace_change_revert", {
      project_id: "p1",
      change_id: "change-1",
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
  delete mismatchedName[2].file_change;
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
    coreEvent(
      "summary_review_requested",
      {
        ...scope,
        interaction_id: "review-1",
        stage: "review-summary",
        is_loading: false,
        loading_phase: null,
        title: "Review web search summary",
        draft_text: "Draft summary",
        summary_model: null,
        draft_metadata: {
          model: {
            provider_id: "local-openai",
            model_id: "gpt-5.4",
          },
          duration_ms: 1_200,
          token_estimate: 42,
          fallback_used: false,
          fallback_reason: null,
        },
        query_draft: "",
        query_notice: null,
        search_providers: [{
          provider_id: "auto",
          display_name: "Automatic",
        }],
        search_provider: "auto",
        sections: [{
          section_id: "0",
          title: "Query",
          body: "Evidence",
          is_selectable: true,
          sources: [{
            title: "Example",
            url: "https://example.com/",
          }],
        }],
        selected_section_ids: ["0"],
      },
      "request-review",
    ),
    coreEvent(
      "summary_review_updated",
      {
        ...scope,
        interaction_id: "review-2",
        stage: "select-evidence",
        is_loading: true,
        loading_phase: "search",
        title: "Select web search evidence",
        draft_text: "",
        summary_model: null,
        draft_metadata: null,
        query_draft: "",
        query_notice: "Searching 0 of 2 queries…",
        search_providers: [{
          provider_id: "auto",
          display_name: "Automatic",
        }],
        search_provider: "auto",
        sections: [],
        selected_section_ids: [],
      },
      "request-review",
    ),
    coreEvent(
      "summary_review_resolved",
      {
        ...scope,
        interaction_id: "review-1",
        decision: "approve",
      },
      "request-review",
    ),
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
    coreEvent("workspace_recovery_notice", {
      code: "workspace_change_quarantine",
      message:
        "One malformed workspace change receipt was isolated.",
      quarantined_receipt_count: 1,
      pending_receipt_count: 0,
      affected_project_count: 1,
    }),
    coreEvent("workspace_recovery_cleared", {}),
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
    coreEvent(
      "workspace_change_snapshot",
      {
        project_id: "project-1",
        workspace_revision: 2,
        change: createWorkspaceChangeDetails(),
      },
      "request-change-read",
    ),
    coreEvent(
      "workspace_change_reverted",
      {
        project_id: "project-1",
        change_id: "change-1",
        tool_name: "write_file",
        path: "/README.md",
        change_kind: "updated",
        workspace_revision: 3,
        reverted_at_workspace_revision: 3,
        revert_outcome: "applied",
      },
      "request-change-revert",
    ),
    coreEvent("error", {
      code: "agent_run_failed",
      message: "Provider failed",
      ...scope,
    }),
  ];

  for (const event of events) assert.deepEqual(parseCoreEvent(event), event);
});

test("validates summary model selections and draft metadata", () => {
  const request = coreEvent(
    "summary_review_requested",
    {
      project_id: "project-1",
      session_id: "session-1",
      interaction_id: "review-1",
      stage: "review-summary",
      is_loading: false,
      loading_phase: null,
      title: "Review web search summary",
      draft_text: "Draft summary",
      summary_model: {
        provider_id: "local-openai",
        model_id: "gpt-5.4",
      },
      draft_metadata: {
        model: {
          provider_id: "local-openai",
          model_id: "gpt-5.4",
        },
        duration_ms: 900,
        token_estimate: 24,
        fallback_used: false,
        fallback_reason: null,
      },
      query_draft: "new angle",
      query_notice: "Review the improved query.",
      search_providers: [{
        provider_id: "auto",
        display_name: "Automatic",
      }, {
        provider_id: "exa",
        display_name: "Exa",
      }],
      search_provider: "auto",
      sections: [{
        section_id: "0",
        title: "Query",
        body: "Evidence",
        is_selectable: true,
        sources: [],
      }],
      selected_section_ids: ["0"],
    },
    "request-review",
  );
  assert.deepEqual(parseCoreEvent(request), request);

  const inconsistentFallback = structuredClone(request);
  inconsistentFallback.payload.draft_metadata.fallback_used = true;
  assert.throws(
    () => parseCoreEvent(inconsistentFallback),
    /inconsistent fallback fields/,
  );

  const invalidDuration = structuredClone(request);
  invalidDuration.payload.draft_metadata.duration_ms = -1;
  assert.throws(
    () => parseCoreEvent(invalidDuration),
    /non-negative/,
  );

  const additiveModel = structuredClone(request);
  additiveModel.payload.summary_model.api_key = "must-not-cross";
  assert.throws(
    () => parseCoreEvent(additiveModel),
    /summary model selection must contain exactly/,
  );

  const oversizedReason = structuredClone(request);
  oversizedReason.payload.draft_metadata = {
    model: null,
    duration_ms: 1,
    token_estimate: 1,
    fallback_used: true,
    fallback_reason: "x".repeat(257),
  };
  assert.throws(
    () => parseCoreEvent(oversizedReason),
    /fallback_reason must not exceed 256 characters/,
  );
});

test("bounds query curation and permits empty evidence selection", () => {
  const selectionRequest = coreEvent(
    "summary_review_requested",
    {
      project_id: "project-1",
      session_id: "session-1",
      interaction_id: "review-1",
      stage: "select-evidence",
      is_loading: false,
      loading_phase: null,
      title: "Select evidence",
      draft_text: "",
      summary_model: null,
      draft_metadata: null,
      query_draft: "another research angle",
      query_notice: null,
      search_providers: [{
        provider_id: "auto",
        display_name: "Automatic",
      }, {
        provider_id: "exa",
        display_name: "Exa",
      }],
      search_provider: "auto",
      sections: [{
        section_id: "0",
        title: "Initial query",
        body: "Evidence",
        is_selectable: true,
        sources: [],
      }],
      selected_section_ids: [],
    },
    "request-review",
  );
  assert.deepEqual(parseCoreEvent(selectionRequest), selectionRequest);

  const loadingRequest = structuredClone(selectionRequest);
  loadingRequest.type = "summary_review_updated";
  loadingRequest.payload.is_loading = true;
  loadingRequest.payload.loading_phase = "search";
  loadingRequest.payload.sections = [];
  assert.deepEqual(parseCoreEvent(loadingRequest), loadingRequest);

  const emptyReadyRequest = structuredClone(loadingRequest);
  emptyReadyRequest.payload.is_loading = false;
  emptyReadyRequest.payload.loading_phase = null;
  assert.throws(
    () => parseCoreEvent(emptyReadyRequest),
    /sections are out of bounds/,
  );

  const loadingDraftRequest = structuredClone(selectionRequest);
  loadingDraftRequest.payload.stage = "review-summary";
  loadingDraftRequest.payload.is_loading = true;
  loadingDraftRequest.payload.loading_phase = "summary";
  assert.throws(
    () => parseCoreEvent(loadingDraftRequest),
    /Only evidence selection may report a loading review/,
  );

  const inconsistentLoadingPhase = structuredClone(selectionRequest);
  inconsistentLoadingPhase.payload.loading_phase = "search";
  assert.throws(
    () => parseCoreEvent(inconsistentLoadingPhase),
    /loading phase must match/,
  );

  const unavailableSelection = structuredClone(selectionRequest);
  unavailableSelection.payload.sections[0].is_selectable = false;
  assert.deepEqual(
    parseCoreEvent(unavailableSelection),
    unavailableSelection,
  );
  unavailableSelection.payload.selected_section_ids = ["0"];
  assert.throws(
    () => parseCoreEvent(unavailableSelection),
    /reference available sections/,
  );

  const unavailableProvider = structuredClone(selectionRequest);
  unavailableProvider.payload.search_provider = "missing";
  assert.throws(
    () => parseCoreEvent(unavailableProvider),
    /reference an available provider/,
  );

  const duplicateProvider = structuredClone(selectionRequest);
  duplicateProvider.payload.search_providers.push({
    provider_id: "auto",
    display_name: "Duplicate",
  });
  assert.throws(
    () => parseCoreEvent(duplicateProvider),
    /must be unique/,
  );

  const addSearch = createCommand("summary_review_resolve", {
    project_id: "project-1",
    session_id: "session-1",
    interaction_id: "review-1",
    resolution: {
      decision: "add-search",
      approved_text: "",
      selected_section_ids: [],
      feedback_text: "",
      summary_model: null,
      search_provider: "auto",
      query_text: "another research angle",
    },
  });
  assert.deepEqual(parseViewerCommand(addSearch), addSearch);

  const changeProvider = structuredClone(addSearch);
  changeProvider.payload.resolution = {
    decision: "change-provider",
    approved_text: "",
    selected_section_ids: [],
    feedback_text: "",
    summary_model: null,
    search_provider: "exa",
    query_text: "",
  };
  assert.deepEqual(
    parseViewerCommand(changeProvider),
    changeProvider,
  );

  const missingProvider = structuredClone(changeProvider);
  missingProvider.payload.resolution.search_provider = null;
  assert.throws(
    () => parseViewerCommand(missingProvider),
    /require a selected search provider/,
  );

  const emptyQuery = structuredClone(addSearch);
  emptyQuery.payload.resolution.query_text = " ";
  assert.throws(
    () => parseViewerCommand(emptyQuery),
    /require query text/,
  );

  const oversizedQuery = structuredClone(addSearch);
  oversizedQuery.payload.resolution.query_text =
    "q".repeat(SUMMARY_REVIEW_MAX_QUERY_LENGTH + 1);
  assert.throws(
    () => parseViewerCommand(oversizedQuery),
    /must not exceed/,
  );

  const reviewRequest = structuredClone(selectionRequest);
  reviewRequest.payload.stage = "review-summary";
  reviewRequest.payload.draft_text = "Draft summary";
  assert.throws(
    () => parseCoreEvent(reviewRequest),
    /selected section ids/,
  );
});

test("rejects impossible workspace recovery counts", () => {
  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent("workspace_recovery_notice", {
          code: "workspace_change_quarantine",
          message: "Malformed receipts were isolated.",
          quarantined_receipt_count: 1,
          pending_receipt_count: 0,
          affected_project_count: 2,
        }),
      ),
    /counts are inconsistent/,
  );
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

test("project new-chat draft visibility is optional and strictly boolean", () => {
  const legacy = parseCoreEvent(
    coreEvent("state_snapshot", { state: createVirtualState() }),
  );
  assert.equal(
    Object.hasOwn(
      legacy.payload.state.projects[0],
      "has_new_chat_draft",
    ),
    false,
  );

  for (const hasNewChatDraft of [false, true]) {
    const state = createVirtualState();
    state.projects[0].has_new_chat_draft = hasNewChatDraft;
    const parsed = parseCoreEvent(
      coreEvent("state_snapshot", { state }),
    );
    assert.equal(
      parsed.payload.state.projects[0].has_new_chat_draft,
      hasNewChatDraft,
    );
  }

  const invalid = createVirtualState();
  invalid.projects[0].has_new_chat_draft = "true";
  assert.throws(
    () => parseCoreEvent(coreEvent("state_snapshot", { state: invalid })),
    /has_new_chat_draft must be a boolean/,
  );
});

test("requires request correlation for commands and interactive results", () => {
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
    coreEvent("workspace_change_snapshot", {
      project_id: "project-1",
      workspace_revision: 0,
      change: createWorkspaceChangeDetails(),
    }),
    coreEvent("workspace_change_reverted", {
      project_id: "project-1",
      change_id: "change-1",
      tool_name: "write_file",
      path: "/README.md",
      change_kind: "updated",
      workspace_revision: 1,
      reverted_at_workspace_revision: 1,
      revert_outcome: "applied",
    }),
    coreEvent("summary_review_requested", {
      project_id: "project-1",
      session_id: "session-1",
      interaction_id: "review-1",
      stage: "select-evidence",
      is_loading: false,
      loading_phase: null,
      title: "Select evidence",
      draft_text: "",
      summary_model: null,
      draft_metadata: null,
      query_draft: "",
      query_notice: null,
      search_providers: [{
        provider_id: "auto",
        display_name: "Automatic",
      }],
      search_provider: "auto",
      sections: [{
        section_id: "0",
        title: "Query",
        body: "Evidence",
        is_selectable: true,
        sources: [],
      }],
      selected_section_ids: ["0"],
    }),
    coreEvent("summary_review_resolved", {
      project_id: "project-1",
      session_id: "session-1",
      interaction_id: "review-1",
      decision: "summarize",
    }),
  ]) {
    assert.throws(() => parseCoreEvent(event), /require request_id/);
  }

  for (const code of [
    "run_in_progress",
    "workspace_change_not_found",
    "workspace_change_conflict",
    "workspace_change_read_failed",
    "workspace_change_revert_failed",
    "summary_review_not_found",
  ]) {
    assert.throws(
      () =>
        parseCoreEvent(
          coreEvent("error", {
            code,
            message: "Change operation failed.",
            project_id: "project-1",
          }),
        ),
      /require request_id/,
    );
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
  for (const type of [
    "workspace_change_read",
    "workspace_change_revert",
  ]) {
    assert.throws(
      () =>
        parseViewerCommand({
          protocol_version: PROTOCOL_VERSION,
          request_id: `request-extra-${type}`,
          type,
          payload: {
            project_id: "project-1",
            change_id: "change-1",
            path: "/README.md",
          },
        }),
      new RegExp(`${type} payload must contain exactly`),
    );
  }
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

  const mismatchedToolName = createTimeline();
  mismatchedToolName[2].file_change.tool_name = "replace_text";
  assert.throws(
    () => parseTimeline(mismatchedToolName),
    /file_change must match tool_name/,
  );

  const deletionTimeline = createTimeline();
  deletionTimeline[1].blocks[2].tool_name = "remove_file";
  deletionTimeline[1].blocks[2].arguments = { path: "/README.md" };
  deletionTimeline[2].tool_name = "remove_file";
  deletionTimeline[2].file_change = {
    ...deletionTimeline[2].file_change,
    tool_name: "remove_file",
    change_kind: "deleted",
    additions: 0,
    deletions: 2,
    byte_size: 0,
  };
  assert.deepEqual(parseTimeline(deletionTimeline), deletionTimeline);

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

  for (const invalid of [
    { ...createWorkspaceChangeDetails(), revert_status: "pending" },
    { ...createWorkspaceChangeDetails(), current_content: undefined },
    { ...createWorkspaceChangeDetails(), before_content: 42 },
    {
      ...createWorkspaceChangeDetails(),
      change_kind: "created",
      before_content: "# Impossible",
    },
    {
      ...createWorkspaceChangeDetails(),
      tool_name: "remove_file",
    },
    {
      ...createWorkspaceChangeDetails(),
      tool_name: "replace_text",
      change_kind: "created",
      before_content: null,
    },
    {
      ...createWorkspaceChangeDetails(),
      change_kind: "deleted",
      after_content: null,
      current_content: null,
    },
    { ...createWorkspaceChangeDetails(), before_content: null },
    {
      ...createWorkspaceChangeDetails(),
      current_content: null,
    },
    {
      ...createWorkspaceChangeDetails(),
      revert_status: "already_reverted",
    },
    {
      ...createWorkspaceChangeDetails(),
      revert_status: "conflict",
      reverted_at_workspace_revision: 2,
    },
    { ...createWorkspaceChangeDetails(), preview_html: "<p>unsafe</p>" },
  ]) {
    assert.throws(
      () =>
        parseCoreEvent(
          coreEvent(
            "workspace_change_snapshot",
            {
              project_id: "project-1",
              workspace_revision: 2,
              change: invalid,
            },
            "workspace-change-request",
          ),
        ),
      /Workspace change details|revert status|revert revision|contents|before_content|current_content|after_content|tool_name/,
    );
  }

  for (const currentContent of [null, "", "# Changed", "# After"]) {
    const event = coreEvent(
      "workspace_change_snapshot",
      {
        project_id: "project-1",
        workspace_revision: 2,
        change: {
          ...createWorkspaceChangeDetails(),
          current_content: currentContent,
          revert_status: "conflict",
        },
      },
      "workspace-change-request",
    );
    assert.deepEqual(parseCoreEvent(event), event);
  }

  const alreadyReverted = coreEvent(
    "workspace_change_snapshot",
    {
      project_id: "project-1",
      workspace_revision: 4,
      change: {
        ...createWorkspaceChangeDetails(),
        current_content: "# Later edit",
        reverted_at_workspace_revision: 3,
        revert_status: "already_reverted",
      },
    },
    "already-reverted-workspace-change",
  );
  assert.deepEqual(parseCoreEvent(alreadyReverted), alreadyReverted);

  const created = coreEvent(
    "workspace_change_snapshot",
    {
      project_id: "project-1",
      workspace_revision: 2,
      change: {
        ...createWorkspaceChangeDetails(),
        change_kind: "created",
        before_content: null,
        after_content: "",
        current_content: "",
      },
    },
    "created-workspace-change",
  );
  assert.deepEqual(parseCoreEvent(created), created);

  const deleted = coreEvent(
    "workspace_change_snapshot",
    {
      project_id: "project-1",
      workspace_revision: 2,
      change: {
        ...createWorkspaceChangeDetails(),
        tool_name: "remove_file",
        change_kind: "deleted",
        before_content: "# Before",
        after_content: null,
        current_content: null,
        additions: 0,
        deletions: 1,
        byte_size: 0,
      },
    },
    "deleted-workspace-change",
  );
  assert.deepEqual(parseCoreEvent(deleted), deleted);

  const deletedRevert = coreEvent(
    "workspace_change_reverted",
    {
      project_id: "project-1",
      change_id: "change-delete",
      tool_name: "remove_file",
      path: "/obsolete.md",
      change_kind: "deleted",
      workspace_revision: 3,
      reverted_at_workspace_revision: 3,
      revert_outcome: "applied",
    },
    "deleted-workspace-change-revert",
  );
  assert.deepEqual(parseCoreEvent(deletedRevert), deletedRevert);

  assert.throws(
    () =>
      parseCoreEvent(
        coreEvent(
          "workspace_change_snapshot",
          {
            project_id: "project-1",
            workspace_revision: 2,
            change: {
              ...createWorkspaceChangeDetails(),
              current_content: "# Before",
              reverted_at_workspace_revision: 3,
              revert_status: "already_reverted",
            },
          },
          "future-revert-revision",
        ),
      ),
    /cannot exceed workspace_revision/,
  );

  for (const invalid of [
    {
      workspace_revision: 3,
      reverted_at_workspace_revision: 2,
      revert_outcome: "applied",
    },
    {
      workspace_revision: 2,
      reverted_at_workspace_revision: 3,
      revert_outcome: "already_reverted",
    },
    {
      workspace_revision: 3,
      reverted_at_workspace_revision: 3,
      revert_outcome: "pending",
    },
  ]) {
    assert.throws(
      () =>
        parseCoreEvent(
          coreEvent(
            "workspace_change_reverted",
            {
              project_id: "project-1",
              change_id: "change-1",
              tool_name: "write_file",
              path: "/README.md",
              change_kind: "updated",
              ...invalid,
            },
            "invalid-revert-outcome",
          ),
        ),
      /revert outcome|revert revisions/,
    );
  }
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
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-invalid-bootstrap",
        type: "bootstrap",
        payload: { active_session_id: null },
      }),
    /requires active_project_id/,
  );
  assert.throws(
    () =>
      parseViewerCommand({
        protocol_version: 8,
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
    tool_name: "write_file",
    path: "/README.md",
    change_kind: "updated",
    additions: 2,
    deletions: 1,
    byte_size: 42,
  };
}

function createWorkspaceChangeDetails() {
  return {
    ...createFileChange(),
    before_content: "# Before",
    after_content: "# After",
    current_content: "# After",
    reverted_at_workspace_revision: null,
    revert_status: "available",
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
