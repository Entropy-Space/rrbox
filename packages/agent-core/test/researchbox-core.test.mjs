import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { MemoryProjectStore } from "@researchbox/project-store";
import { createCommand } from "@researchbox/protocol";
import {
  MemoryFileSystem,
  MemoryWorkspaceBackend,
} from "@researchbox/vfs";
import { ResearchBoxCore } from "../src/index.ts";

const model = {
  id: "test-model",
  name: "Test model",
  api: "researchbox-mock",
  provider: "researchbox",
  baseUrl: "/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

const localModel = {
  ...model,
  id: "local-model",
  name: "Local model",
  api: "openai-completions",
  provider: "local-openai",
  baseUrl: "",
};

test("summary review pauses a tool until the viewer approves it", async () => {
  const events = [];
  let reviewActivityCount = 0;
  let publishReviewResults;
  const reviewResultsReady = new Promise((resolve) => {
    publishReviewResults = resolve;
  });
  const core = createCore(
    new MemoryProjectStore(),
    createWorkspaceProvider(),
    events,
    {
      async *stream(request) {
        const hasReviewResult = request.messages.some(
          (message) =>
            message.role === "tool" &&
            message.tool_name === "review_test",
        );
        if (!hasReviewResult) {
          yield* toolCallEvents({
            tool_call_id: "review-call",
            tool_name: "review_test",
            arguments: {},
          });
          yield { type: "done", stop_reason: "tool_use" };
          return;
        }
        yield* textEvents("Used the approved summary.");
        yield { type: "done", stop_reason: "stop" };
      },
    },
    {
      plugins: [{
        id: "review-test",
        createTools(context) {
          return [{
            name: "review_test",
            label: "Review",
            description: "Exercise summary review.",
            parameters: Type.Object({}),
            async execute(_callId, _params, signal) {
              const interaction = context.open_summary_review({
                stage: "select-evidence",
                is_loading: true,
                loading_phase: "search",
                title: "Find evidence",
                draft_text: "",
                summary_model: null,
                draft_metadata: null,
                query_draft: "",
                query_notice: "Searching…",
                search_providers: [{
                  provider_id: "auto",
                  display_name: "Automatic",
                }, {
                  provider_id: "exa",
                  display_name: "Exa",
                }],
                search_provider: "auto",
                sections: [],
                selected_section_ids: [],
              }, signal);
              const unsubscribeActivity = interaction.subscribe_activity(
                () => {
                  reviewActivityCount += 1;
                },
              );
              await reviewResultsReady;
              interaction.update({
                stage: "review-summary",
                is_loading: false,
                loading_phase: null,
                title: "Review summary",
                draft_text: "Draft summary",
                summary_model: null,
                draft_metadata: null,
                query_draft: "",
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
                  title: "Query",
                  body: "Evidence",
                  is_selectable: true,
                  sources: [{
                    title: "Source",
                    url: "https://example.com/",
                  }],
                }, {
                  section_id: "1",
                  title: "Failed provider",
                  body: "Provider unavailable",
                  is_selectable: false,
                  sources: [],
                }],
                selected_section_ids: ["0"],
              });
              const resolution = await interaction.resolution;
              unsubscribeActivity();
              return {
                content: [{
                  type: "text",
                  text: resolution.approved_text,
                }],
                details: { summary: "Reviewed" },
              };
            },
          }];
        },
      }],
    },
  );

  await core.handle(createCommand("bootstrap", {}));
  const state = latestState(events);
  const prompt = core.handle(createCommand("prompt", {
    project_id: state.active_project_id,
    session_id: null,
    text: "Review this search.",
  }));
  await waitForCondition(
    () => events.some((event) => event.type === "summary_review_requested"),
  );
  const review = events.findLast(
    (event) => event.type === "summary_review_requested",
  );
  assert.equal(review.payload.is_loading, true);
  assert.deepEqual(review.payload.sections, []);
  await core.handle(createCommand("summary_review_touch", {
    project_id: review.payload.project_id,
    session_id: review.payload.session_id,
    interaction_id: review.payload.interaction_id,
  }));
  assert.equal(reviewActivityCount, 1);
  await core.handle(createCommand("summary_review_resolve", {
    project_id: review.payload.project_id,
    session_id: review.payload.session_id,
    interaction_id: review.payload.interaction_id,
    resolution: {
      decision: "approve",
      approved_text: "Premature summary",
      selected_section_ids: [],
      feedback_text: "",
      summary_model: null,
      search_provider: "auto",
      query_text: "",
    },
  }));
  assert.match(
    events.findLast((event) => event.type === "error").payload.message,
    /cannot be submitted while it is loading/u,
  );

  publishReviewResults();
  await waitForCondition(
    () => events.some((event) => event.type === "summary_review_updated"),
  );
  const reviewUpdate = events.findLast(
    (event) => event.type === "summary_review_updated",
  );
  assert.equal(
    reviewUpdate.payload.interaction_id,
    review.payload.interaction_id,
  );
  assert.equal(reviewUpdate.payload.draft_text, "Draft summary");

  await core.handle(createCommand("summary_review_resolve", {
    project_id: review.payload.project_id,
    session_id: review.payload.session_id,
    interaction_id: review.payload.interaction_id,
    resolution: {
      decision: "summarize",
      approved_text: "",
      selected_section_ids: ["0"],
      feedback_text: "",
      summary_model: null,
      search_provider: "missing",
      query_text: "",
    },
  }));
  assert.match(
    events.findLast((event) => event.type === "error").payload.message,
    /unavailable search provider/u,
  );

  await core.handle(createCommand("summary_review_resolve", {
    project_id: review.payload.project_id,
    session_id: review.payload.session_id,
    interaction_id: review.payload.interaction_id,
    resolution: {
      decision: "summarize",
      approved_text: "",
      selected_section_ids: ["1"],
      feedback_text: "",
      summary_model: null,
      search_provider: "auto",
      query_text: "",
    },
  }));
  assert.equal(
    events.findLast((event) => event.type === "error").payload.code,
    "summary_review_not_found",
  );

  await core.handle(createCommand("summary_review_resolve", {
    project_id: review.payload.project_id,
    session_id: review.payload.session_id,
    interaction_id: review.payload.interaction_id,
    resolution: {
      decision: "approve",
      approved_text: "Approved summary",
      selected_section_ids: ["0"],
      feedback_text: "",
      summary_model: null,
      search_provider: "auto",
      query_text: "",
    },
  }));
  await prompt;

  await core.handle(createCommand("summary_review_touch", {
    project_id: review.payload.project_id,
    session_id: review.payload.session_id,
    interaction_id: review.payload.interaction_id,
  }));
  assert.equal(reviewActivityCount, 1);

  assert.equal(
    events.filter((event) => event.type === "summary_review_resolved").length,
    1,
  );
  const finalState = latestState(events);
  const result = finalState.timeline.find(
    (entry) =>
      entry.type === "tool_result" &&
      entry.tool_name === "review_test",
  );
  assert.equal(result.content, "Approved summary");
});

test("loading summary reviews permit phase-scoped search mutations", async (t) => {
  for (const testCase of [{
    name: "provider change during search",
    loading_phase: "search",
    decision: "change-provider",
    search_provider: "exa",
    query_text: "",
  }, {
    name: "added search during summary generation",
    loading_phase: "summary",
    decision: "add-search",
    search_provider: "auto",
    query_text: "another angle",
  }]) {
    await t.test(testCase.name, async () => {
      const events = [];
      const core = createCore(
        new MemoryProjectStore(),
        createWorkspaceProvider(),
        events,
        {
          async *stream(request) {
            const hasResult = request.messages.some(
              (message) =>
                message.role === "tool" &&
                message.tool_name === "loading_review_test",
            );
            if (!hasResult) {
              yield* toolCallEvents({
                tool_call_id: "loading-review-call",
                tool_name: "loading_review_test",
                arguments: {},
              });
              yield { type: "done", stop_reason: "tool_use" };
              return;
            }
            yield* textEvents("Continued after review mutation.");
            yield { type: "done", stop_reason: "stop" };
          },
        },
        {
          plugins: [{
            id: "loading-review-test",
            createTools(context) {
              return [{
                name: "loading_review_test",
                label: "Loading review",
                description: "Exercise loading review mutations.",
                parameters: Type.Object({}),
                async execute(_callId, _params, signal) {
                  const resolution = await context.request_summary_review({
                    stage: "select-evidence",
                    is_loading: true,
                    loading_phase: testCase.loading_phase,
                    title: "Loading review",
                    draft_text: "",
                    summary_model: null,
                    draft_metadata: null,
                    query_draft: testCase.query_text,
                    query_notice: "Working…",
                    search_providers: [{
                      provider_id: "auto",
                      display_name: "Automatic",
                    }, {
                      provider_id: "exa",
                      display_name: "Exa",
                    }],
                    search_provider: "auto",
                    sections: [],
                    selected_section_ids: [],
                  }, signal);
                  return {
                    content: [{
                      type: "text",
                      text: resolution.decision,
                    }],
                    details: { summary: "Review mutated" },
                  };
                },
              }];
            },
          }],
        },
      );

      await core.handle(createCommand("bootstrap", {}));
      const state = latestState(events);
      const prompt = core.handle(createCommand("prompt", {
        project_id: state.active_project_id,
        session_id: null,
        text: "Mutate this loading review.",
      }));
      await waitForCondition(
        () =>
          events.some(
            (event) => event.type === "summary_review_requested",
          ),
      );
      const review = events.findLast(
        (event) => event.type === "summary_review_requested",
      );
      await core.handle(createCommand("summary_review_resolve", {
        project_id: review.payload.project_id,
        session_id: review.payload.session_id,
        interaction_id: review.payload.interaction_id,
        resolution: {
          decision: testCase.decision,
          approved_text: "",
          selected_section_ids: [],
          feedback_text: "",
          summary_model: null,
          search_provider: testCase.search_provider,
          query_text: testCase.query_text,
        },
      }));
      await prompt;

      const result = latestState(events).timeline.find(
        (entry) =>
          entry.type === "tool_result" &&
          entry.tool_name === "loading_review_test",
      );
      assert.equal(result.content, testCase.decision);
    });
  }
});

test("a local review deadline clears the interaction without aborting the run", async () => {
  const events = [];
  const reviewDeadline = new AbortController();
  const core = createCore(
    new MemoryProjectStore(),
    createWorkspaceProvider(),
    events,
    {
      async *stream(request) {
        const hasReviewResult = request.messages.some(
          (message) =>
            message.role === "tool" &&
            message.tool_name === "review_timeout_test",
        );
        if (!hasReviewResult) {
          yield* toolCallEvents({
            tool_call_id: "review-timeout-call",
            tool_name: "review_timeout_test",
            arguments: {},
          });
          yield { type: "done", stop_reason: "tool_use" };
          return;
        }
        yield* textEvents("Used the timeout fallback.");
        yield { type: "done", stop_reason: "stop" };
      },
    },
    {
      plugins: [{
        id: "review-timeout-test",
        createTools(context) {
          return [{
            name: "review_timeout_test",
            label: "Review timeout",
            description: "Exercise a local review deadline.",
            parameters: Type.Object({}),
            async execute(_callId, _params, signal) {
              try {
                await context.request_summary_review({
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
                }, AbortSignal.any([signal, reviewDeadline.signal]));
                throw new Error("The review unexpectedly resolved.");
              } catch (error) {
                if (
                  !(error instanceof DOMException) ||
                  error.name !== "AbortError" ||
                  signal.aborted
                ) {
                  throw error;
                }
              }
              return {
                content: [{
                  type: "text",
                  text: "Deterministic timeout fallback",
                }],
                details: { summary: "Review timed out" },
              };
            },
          }];
        },
      }],
    },
  );

  await core.handle(createCommand("bootstrap", {}));
  const state = latestState(events);
  const prompt = core.handle(createCommand("prompt", {
    project_id: state.active_project_id,
    session_id: null,
    text: "Review with a deadline.",
  }));
  await waitForCondition(
    () => events.some((event) => event.type === "summary_review_requested"),
  );
  const review = events.findLast(
    (event) => event.type === "summary_review_requested",
  );

  reviewDeadline.abort();
  await prompt;

  const finalState = latestState(events);
  const result = finalState.timeline.find(
    (entry) =>
      entry.type === "tool_result" &&
      entry.tool_name === "review_timeout_test",
  );
  assert.equal(result.content, "Deterministic timeout fallback");
  assert.equal(
    events.findLast((event) => event.type === "run_state")
      .payload.is_running,
    false,
  );

  await core.handle(createCommand("summary_review_resolve", {
    project_id: review.payload.project_id,
    session_id: review.payload.session_id,
    interaction_id: review.payload.interaction_id,
    resolution: {
      decision: "summarize",
      approved_text: "",
      selected_section_ids: ["0"],
      feedback_text: "",
      summary_model: null,
      search_provider: "auto",
      query_text: "",
    },
  }));
  assert.equal(
    events.findLast((event) => event.type === "error").payload.code,
    "summary_review_not_found",
  );
});

test("plugin completion resolves an explicitly selected ready model", async () => {
  const events = [];
  const requests = [];
  const core = createCore(
    new MemoryProjectStore(),
    createWorkspaceProvider(),
    events,
    {
      async *stream(request) {
        requests.push({
          provider_id: request.provider_id,
          model_id: request.model_id,
        });
        if (
          request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content === "Summarize selected evidence.",
          )
        ) {
          yield* textEvents("Local summary");
          yield { type: "done", stop_reason: "stop" };
          return;
        }
        const hasToolResult = request.messages.some(
          (message) =>
            message.role === "tool" &&
            message.tool_name === "summary_model_test",
        );
        if (!hasToolResult) {
          yield* toolCallEvents({
            tool_call_id: "summary-model-call",
            tool_name: "summary_model_test",
            arguments: {},
          });
          yield { type: "done", stop_reason: "tool_use" };
          return;
        }
        yield* textEvents("Used the selected summary model.");
        yield { type: "done", stop_reason: "stop" };
      },
    },
    {
      providers: [
        {
          provider_id: model.provider,
          display_name: "ResearchBox",
          kind: "mock",
          models: [model],
        },
        {
          provider_id: localModel.provider,
          display_name: "Local OpenAI",
          kind: "openai_compatible",
          models: [localModel],
        },
      ],
      plugins: [{
        id: "summary-model-test",
        createTools(context) {
          return [{
            name: "summary_model_test",
            label: "Summary model",
            description: "Exercise plugin model selection.",
            parameters: Type.Object({}),
            async execute(_callId, _params, signal) {
              const completion = await context.complete_model(
                "Summarize selected evidence.",
                signal,
                {
                  provider_id: localModel.provider,
                  model_id: localModel.id,
                },
              );
              return {
                content: [{ type: "text", text: completion.text }],
                details: { summary: "Summarized" },
              };
            },
          }];
        },
      }],
    },
  );

  await core.handle(createCommand("bootstrap", {}));
  const state = latestState(events);
  await core.handle(createCommand("prompt", {
    project_id: state.active_project_id,
    session_id: null,
    text: "Use another summary model.",
  }));

  const toolResult = latestState(events).timeline.find(
    (entry) =>
      entry.type === "tool_result" &&
      entry.tool_name === "summary_model_test",
  );
  assert.equal(toolResult?.is_error, false, toolResult?.content);
  assert.deepEqual(requests, [
    {
      provider_id: model.provider,
      model_id: model.id,
    },
    {
      provider_id: localModel.provider,
      model_id: localModel.id,
    },
    {
      provider_id: model.provider,
      model_id: model.id,
    },
  ]);
  assert.equal(toolResult.content, "Local summary");
});

test("accepts the deprecated workspace provider composition option", async () => {
  const events = [];
  const core = new ResearchBoxCore({
    projectStore: new MemoryProjectStore(),
    workspaceProvider: createWorkspaceProvider(),
    modelTransport: {
      async *stream() {
        yield { type: "done" };
      },
    },
    model,
    systemPrompt: "You are a test agent.",
    eventSink: (event) => events.push(event),
  });

  await core.handle(createCommand("bootstrap", {}));
  assert.equal(latestState(events).active_session_id, null);
});

test("concurrent first bootstraps converge before orphan reconciliation", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const createdProjectIds = [];
  const createWorkspace = provider.create.bind(provider);
  provider.create = async (projectId, options) => {
    createdProjectIds.push(projectId);
    return createWorkspace(projectId, options);
  };
  const firstEvents = [];
  const secondEvents = [];
  const firstCore = createCore(store, provider, firstEvents);
  const secondCore = createCore(store, provider, secondEvents);

  await Promise.all([
    firstCore.handle(createCommand("bootstrap", {})),
    secondCore.handle(createCommand("bootstrap", {})),
  ]);

  const canonical = await store.load();
  assert.ok(canonical);
  assert.equal(canonical.projects.length, 1);
  assert.equal(createdProjectIds.length, 2);
  assert.equal(
    latestState(firstEvents).active_project_id,
    canonical.active_project_id,
  );
  assert.equal(
    latestState(secondEvents).active_project_id,
    canonical.active_project_id,
  );
  await provider.open(canonical.active_project_id);
  const orphanedProjectId = createdProjectIds.find(
    (projectId) => projectId !== canonical.active_project_id,
  );
  assert.ok(orphanedProjectId);
  await assert.rejects(
    provider.open(orphanedProjectId),
    (error) => error?.code === "not_found",
  );
});

test("reconciles crash-orphaned workspaces before opening persisted projects", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const firstEvents = [];
  const firstCore = createCore(store, provider, firstEvents);
  await firstCore.handle(createCommand("bootstrap", {}));
  await firstCore.handle(createCommand("project_create", { name: "Second" }));
  const persisted = latestState(firstEvents);
  const retainedProjectIds = persisted.projects.map(
    (project) => project.project_id,
  );
  await provider.create("crash-orphan", {
    initial_files: [{ path: "/temporary.txt", content: "orphaned" }],
  });

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));

  assert.equal(
    latestState(reloadedEvents).active_project_id,
    persisted.active_project_id,
  );
  for (const projectId of retainedProjectIds) {
    await provider.open(projectId);
  }
  await assert.rejects(
    provider.open("crash-orphan"),
    (error) => error?.code === "not_found",
  );
});

test("bootstrap reports isolated workspace receipts after becoming ready", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const firstEvents = [];
  await createCore(store, provider, firstEvents).handle(
    createCommand("bootstrap", {}),
  );
  const quarantinedProjectId =
    latestState(firstEvents).active_project_id;

  const originalOpen = provider.open.bind(provider);
  provider.open = async (projectId) => {
    const workspace = await originalOpen(projectId);
    if (projectId !== quarantinedProjectId) return workspace;
    const originalListChanges = workspace.listChanges.bind(workspace);
    workspace.listChanges = async () => ({
      ...(await originalListChanges()),
      quarantine_status: {
        quarantined_receipt_count: 2,
        pending_receipt_count: 1,
      },
    });
    return workspace;
  };

  const events = [];
  const reloaded = createCore(store, provider, events);
  await reloaded.handle(createCommand("bootstrap", {}));

  const readyIndex = events.findIndex((event) => event.type === "ready");
  const noticeIndex = events.findIndex(
    (event) =>
      event.type === "workspace_recovery_notice" &&
      event.payload.code === "workspace_change_quarantine",
  );
  assert.ok(readyIndex >= 0);
  assert.ok(noticeIndex > readyIndex);
  assert.equal(events[noticeIndex].request_id, undefined);
  assert.match(events[noticeIndex].payload.message, /2 malformed/);
  assert.doesNotMatch(events[noticeIndex].payload.message, /legacy/i);
  assert.match(events[noticeIndex].payload.message, /No files, projects, or chats were removed/);
  assert.match(events[noticeIndex].payload.message, /1 isolation marker/);

  await reloaded.handle(createCommand("bootstrap", {}));
  assert.equal(
    events.filter(
      (event) =>
        event.type === "workspace_recovery_notice" &&
        event.payload.code === "workspace_change_quarantine",
    ).length,
    1,
  );

  await reloaded.handle(
    createCommand("project_create", { name: "Replacement" }),
  );
  await reloaded.handle(
    createCommand("project_delete", {
      project_id: quarantinedProjectId,
    }),
  );
  assert.equal(
    events.filter(
      (event) => event.type === "workspace_recovery_cleared",
    ).length,
    1,
  );

  await reloaded.handle(createCommand("bootstrap", {}));
  assert.equal(
    events.filter(
      (event) => event.type === "workspace_recovery_cleared",
    ).length,
    1,
  );
});

test("keeps new chat virtual and persists the first prompt before transport", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let transportStarted = false;
  const core = createCore(store, provider, events, {
    async *stream(request) {
      transportStarted = true;
      const persisted = await store.load();
      const prompt = promptFromRequest(request);
      assert.equal(persisted.sessions.length, 1);
      assert.equal(persisted.active_session_id, persisted.sessions[0].session_id);
      assert.equal(request.session_id, persisted.sessions[0].session_id);
      assert.equal(persisted.projects[0].new_chat_draft, "");
      assert.equal(persisted.documents[0].input_draft, "");
      assert.equal(persisted.documents[0].timeline.length, 1);
      assert.equal(persisted.documents[0].timeline[0].content, prompt);
      yield* textEvents(`Echo: ${prompt}`);
      yield { type: "done" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  assert.equal(initial.active_session_id, null);
  assert.equal(initial.sessions.length, 0);
  assert.equal(initial.input_draft, "");

  await core.handle(
    createCommand("input_draft_update", {
      project_id: initial.active_project_id,
      session_id: null,
      input_draft: "  Plan the persistence layer  ",
    }),
  );
  assert.equal(
    (await store.load()).projects[0].new_chat_draft,
    "  Plan the persistence layer  ",
  );
  assert.equal(events.at(-1).type, "input_draft_saved");

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents, {
    async *stream(request) {
      transportStarted = true;
      const persisted = await store.load();
      const prompt = promptFromRequest(request);
      assert.equal(persisted.sessions.length, 1);
      assert.equal(persisted.documents[0].timeline.length, 1);
      assert.equal(persisted.documents[0].timeline[0].content, prompt);
      yield { type: "done" };
    },
  });
  await reloaded.handle(createCommand("bootstrap", {}));
  assert.equal(
    latestState(reloadedEvents).input_draft,
    "  Plan the persistence layer  ",
  );

  await reloaded.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "  Plan the persistence layer  ",
    }),
  );
  assert.equal(transportStarted, true);
  const persisted = await store.load();
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0].title, "Plan the persistence layer");
  assert.equal(
    persisted.documents[0].timeline[0].content,
    "Plan the persistence layer",
  );
  assert.equal(persisted.documents[0].timeline[1].status, "complete");
  assert.equal(latestState(reloadedEvents).input_draft, "");
});

test("new chat is idempotent and project and session drafts stay isolated", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;

  await core.handle(
    createCommand("prompt", {
      project_id: projectId,
      session_id: null,
      text: "First durable chat",
    }),
  );
  const firstSessionId = latestState(events).active_session_id;
  assert.ok(firstSessionId);

  await core.handle(
    createCommand("input_draft_update", {
      project_id: projectId,
      session_id: firstSessionId,
      input_draft: "session draft",
    }),
  );
  await core.handle(createCommand("new_chat", { project_id: projectId }));
  await core.handle(
    createCommand("input_draft_update", {
      project_id: projectId,
      session_id: null,
      input_draft: "project draft",
    }),
  );
  await core.handle(createCommand("new_chat", { project_id: projectId }));
  assert.equal(latestState(events).active_session_id, null);
  assert.equal(latestState(events).input_draft, "project draft");
  assert.equal(latestState(events).sessions.length, 1);

  await core.handle(
    createCommand("session_select", {
      project_id: projectId,
      session_id: firstSessionId,
    }),
  );
  assert.equal(latestState(events).input_draft, "session draft");
  await core.handle(createCommand("new_chat", { project_id: projectId }));
  assert.equal(latestState(events).input_draft, "project draft");

  await core.handle(
    createCommand("prompt", {
      project_id: projectId,
      session_id: null,
      text: "Second durable chat",
    }),
  );
  const secondSessionId = latestState(events).active_session_id;
  assert.notEqual(secondSessionId, firstSessionId);
  assert.equal(latestState(events).sessions.length, 2);

  await core.handle(
    createCommand("session_select", {
      project_id: projectId,
      session_id: firstSessionId,
    }),
  );
  await core.handle(
    createCommand("session_delete", {
      project_id: projectId,
      session_id: firstSessionId,
    }),
  );
  assert.equal(latestState(events).active_session_id, secondSessionId);
  await core.handle(
    createCommand("session_delete", {
      project_id: projectId,
      session_id: secondSessionId,
    }),
  );
  assert.equal(latestState(events).active_session_id, null);
  assert.equal(latestState(events).sessions.length, 0);
});

test("project summaries expose exact active and inactive new-chat draft presence", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const firstProjectId = latestState(events).active_project_id;
  assert.equal(
    latestState(events).projects.find(
      (project) => project.project_id === firstProjectId,
    )?.has_new_chat_draft,
    false,
  );

  await core.handle(
    createCommand("input_draft_update", {
      project_id: firstProjectId,
      session_id: null,
      input_draft: " \n\t",
    }),
  );
  assert.equal(
    (await store.load()).projects.find(
      (project) => project.project_id === firstProjectId,
    )?.new_chat_draft,
    " \n\t",
  );
  await core.handle(
    createCommand("new_chat", { project_id: firstProjectId }),
  );
  assert.equal(
    latestState(events).projects.find(
      (project) => project.project_id === firstProjectId,
    )?.has_new_chat_draft,
    true,
  );

  await core.handle(createCommand("project_create", { name: "Second" }));
  const secondProjectId = latestState(events).active_project_id;
  const afterCreate = latestState(events);
  assert.equal(
    afterCreate.projects.find(
      (project) => project.project_id === firstProjectId,
    )?.has_new_chat_draft,
    true,
  );
  assert.equal(
    afterCreate.projects.find(
      (project) => project.project_id === secondProjectId,
    )?.has_new_chat_draft,
    false,
  );

  await core.handle(
    createCommand("input_draft_update", {
      project_id: secondProjectId,
      session_id: null,
      input_draft: "Second project draft",
    }),
  );
  assert.equal(
    (await store.load()).projects.find(
      (project) => project.project_id === secondProjectId,
    )?.new_chat_draft,
    "Second project draft",
  );
  await core.handle(
    createCommand("new_chat", { project_id: secondProjectId }),
  );
  const withBothDrafts = latestState(events);
  assert.equal(
    withBothDrafts.projects.find(
      (project) => project.project_id === firstProjectId,
    )?.has_new_chat_draft,
    true,
  );
  assert.equal(
    withBothDrafts.projects.find(
      (project) => project.project_id === secondProjectId,
    )?.has_new_chat_draft,
    true,
  );
});

test("model selection is chat-scoped and survives first send and reload", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const requests = [];
  const modelTransport = {
    async *stream(request) {
      const persisted = await store.load();
      assert.deepEqual(persisted.sessions[0].selected_model, {
        provider_id: request.provider_id,
        model_id: request.model_id,
      });
      requests.push(structuredClone(request));
      yield { type: "done" };
    },
  };
  const createConfiguredCore = (eventSink) =>
    new ResearchBoxCore({
      projectStore: store,
      workspaceBackend: provider,
      modelTransport,
      model,
      providers: [
        {
          provider_id: model.provider,
          display_name: "ResearchBox",
          kind: "mock",
          models: [model],
        },
        {
          provider_id: localModel.provider,
          display_name: "Local OpenAI",
          kind: "openai_compatible",
          models: [localModel],
        },
      ],
      systemPrompt: "You are a test agent.",
      eventSink,
    });

  const core = createConfiguredCore((event) => events.push(event));
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;

  await core.handle(
    createCommand("model_select", {
      project_id: projectId,
      session_id: null,
      provider_id: localModel.provider,
      model_id: localModel.id,
    }),
  );
  assert.deepEqual(latestState(events).active_model, {
    provider_id: localModel.provider,
    model_id: localModel.id,
  });
  assert.deepEqual((await store.load()).projects[0].new_chat_model, {
    provider_id: localModel.provider,
    model_id: localModel.id,
  });

  await core.handle(
    createCommand("prompt", {
      project_id: projectId,
      session_id: null,
      text: "Use the local model",
    }),
  );
  const sessionId = latestState(events).active_session_id;
  assert.ok(sessionId);
  assert.equal(requests[0].provider_id, localModel.provider);
  assert.equal(requests[0].model_id, localModel.id);
  assert.deepEqual((await store.load()).sessions[0].selected_model, {
    provider_id: localModel.provider,
    model_id: localModel.id,
  });

  await core.handle(
    createCommand("model_select", {
      project_id: projectId,
      session_id: sessionId,
      provider_id: model.provider,
      model_id: model.id,
    }),
  );
  assert.deepEqual((await store.load()).sessions[0].selected_model, {
    provider_id: model.provider,
    model_id: model.id,
  });

  await core.handle(createCommand("new_chat", { project_id: projectId }));
  assert.deepEqual(latestState(events).active_model, {
    provider_id: localModel.provider,
    model_id: localModel.id,
  });

  const reloadedEvents = [];
  const reloaded = createConfiguredCore((event) => reloadedEvents.push(event));
  await reloaded.handle(
    createCommand("bootstrap", {
      active_project_id: projectId,
      active_session_id: null,
    }),
  );
  assert.deepEqual(latestState(reloadedEvents).active_model, {
    provider_id: localModel.provider,
    model_id: localModel.id,
  });
});

test("dynamic providers refresh, reject non-tool models, and recover", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let discoveryFailure = null;
  const descriptors = [
    {
      provider_id: "local-openai",
      provider_display_name: "Local OpenAI",
      model_id: "tool-model",
      display_name: "Tool model",
      context_window: 128_000,
      max_output_tokens: 8_192,
      supports_tools: true,
      supports_reasoning: false,
    },
    {
      provider_id: "local-openai",
      provider_display_name: "Local OpenAI",
      model_id: "text-only-model",
      display_name: "Text only model",
      context_window: 128_000,
      max_output_tokens: 8_192,
      supports_tools: false,
      supports_reasoning: false,
    },
  ];
  const core = new ResearchBoxCore({
    projectStore: store,
    workspaceBackend: provider,
    modelTransport: {
      async *stream() {
        yield { type: "done" };
      },
    },
    modelCatalog: {
      async listModels() {
        if (discoveryFailure) throw discoveryFailure;
        return descriptors;
      },
    },
    model,
    providers: [
      {
        provider_id: model.provider,
        display_name: "ResearchBox",
        kind: "mock",
        models: [model],
      },
      {
        provider_id: "local-openai",
        display_name: "Local OpenAI",
        kind: "openai_compatible",
        discover_models: true,
      },
    ],
    systemPrompt: "You are a test agent.",
    eventSink: (event) => events.push(event),
  });

  await core.handle(createCommand("bootstrap", {}));
  await core.handle(
    createCommand("provider_refresh", { provider_id: "local-openai" }),
  );
  const readyState = latestState(events);
  const localProvider = readyState.providers.find(
    (candidate) => candidate.provider_id === "local-openai",
  );
  assert.equal(localProvider.availability, "ready");
  assert.equal(
    localProvider.models.find(
      (candidate) => candidate.model_id === "tool-model",
    ).availability,
    "ready",
  );
  assert.equal(
    localProvider.models.find(
      (candidate) => candidate.model_id === "text-only-model",
    ).availability,
    "unavailable",
  );

  const projectId = readyState.active_project_id;
  await core.handle(
    createCommand("model_select", {
      project_id: projectId,
      session_id: null,
      provider_id: "local-openai",
      model_id: "text-only-model",
    }),
  );
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).payload.code, "model_unavailable");

  await core.handle(
    createCommand("model_select", {
      project_id: projectId,
      session_id: null,
      provider_id: "local-openai",
      model_id: "tool-model",
    }),
  );
  assert.deepEqual(latestState(events).active_model, {
    provider_id: "local-openai",
    model_id: "tool-model",
  });

  discoveryFailure = new Error("gateway offline");
  await core.handle(
    createCommand("provider_refresh", { provider_id: "local-openai" }),
  );
  assert.equal(
    latestState(events).providers.find(
      (candidate) => candidate.provider_id === "local-openai",
    ).availability,
    "unavailable",
  );

  discoveryFailure = null;
  await core.handle(
    createCommand("provider_refresh", { provider_id: "local-openai" }),
  );
  assert.equal(
    latestState(events).providers.find(
      (candidate) => candidate.provider_id === "local-openai",
    ).availability,
    "ready",
  );
});

test("persisted dynamic model becomes ready after reload discovery", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const descriptor = {
    provider_id: "local-openai",
    provider_display_name: "Local OpenAI",
    model_id: "persisted-model",
    display_name: "Persisted model",
    context_window: 128_000,
    max_output_tokens: 8_192,
    supports_tools: true,
    supports_reasoning: false,
  };
  const providers = [
    {
      provider_id: model.provider,
      display_name: "ResearchBox",
      kind: "mock",
      models: [model],
    },
    {
      provider_id: "local-openai",
      display_name: "Local OpenAI",
      kind: "openai_compatible",
      discover_models: true,
    },
  ];
  const createDynamicCore = (modelCatalog, eventSink) =>
    new ResearchBoxCore({
      projectStore: store,
      workspaceBackend: provider,
      modelTransport: {
        async *stream() {
          yield { type: "done" };
        },
      },
      modelCatalog,
      model,
      providers,
      systemPrompt: "You are a test agent.",
      eventSink,
    });

  const initialEvents = [];
  const initial = createDynamicCore(
    {
      async listModels() {
        return [descriptor];
      },
    },
    (event) => initialEvents.push(event),
  );
  await initial.handle(createCommand("bootstrap", {}));
  await initial.handle(
    createCommand("provider_refresh", { provider_id: "local-openai" }),
  );
  const projectId = latestState(initialEvents).active_project_id;
  await initial.handle(
    createCommand("model_select", {
      project_id: projectId,
      session_id: null,
      provider_id: descriptor.provider_id,
      model_id: descriptor.model_id,
    }),
  );
  assert.deepEqual((await store.load()).projects[0].new_chat_model, {
    provider_id: descriptor.provider_id,
    model_id: descriptor.model_id,
  });

  let releaseDiscovery;
  let discoveryCalls = 0;
  const discovery = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  const reloadedEvents = [];
  const reloaded = createDynamicCore(
    {
      async listModels() {
        discoveryCalls += 1;
        return discovery;
      },
    },
    (event) => reloadedEvents.push(event),
  );
  await reloaded.handle(createCommand("bootstrap", {}));

  const readyState = reloadedEvents.find((event) => event.type === "ready")
    .payload.state;
  const loadingProvider = readyState.providers.find(
    (candidate) => candidate.provider_id === descriptor.provider_id,
  );
  assert.deepEqual(readyState.active_model, {
    provider_id: descriptor.provider_id,
    model_id: descriptor.model_id,
  });
  assert.equal(loadingProvider.availability, "loading");
  assert.equal(
    loadingProvider.models.find(
      (candidate) => candidate.model_id === descriptor.model_id,
    ).availability,
    "unavailable",
  );

  const refresh = reloaded.handle(
    createCommand("provider_refresh", { provider_id: descriptor.provider_id }),
  );
  releaseDiscovery([descriptor]);
  await refresh;

  const refreshedState = latestState(reloadedEvents);
  const refreshedProvider = refreshedState.providers.find(
    (candidate) => candidate.provider_id === descriptor.provider_id,
  );
  assert.equal(discoveryCalls, 1);
  assert.equal(refreshedProvider.availability, "ready");
  assert.equal(
    refreshedProvider.models.find(
      (candidate) => candidate.model_id === descriptor.model_id,
    ).availability,
    "ready",
  );
  assert.deepEqual(refreshedState.active_model, readyState.active_model);
});

test("provider refresh recovers when its loading snapshot fails", async () => {
  const store = new MemoryProjectStore();
  const workspace = new MemoryFileSystem({ "/README.md": "# Test" });
  const provider = new MemoryWorkspaceBackend(() => workspace);
  const events = [];
  let listCalls = 0;
  let discoveryCalls = 0;
  const list = workspace.list.bind(workspace);
  workspace.list = async (path) => {
    listCalls += 1;
    if (listCalls === 2) throw new Error("transient list failure");
    return list(path);
  };
  const descriptor = {
    provider_id: "local-openai",
    provider_display_name: "Local OpenAI",
    model_id: "tool-model",
    display_name: "Tool model",
    context_window: 128_000,
    max_output_tokens: 8_192,
    supports_tools: true,
    supports_reasoning: false,
  };
  const core = new ResearchBoxCore({
    projectStore: store,
    workspaceBackend: provider,
    modelTransport: {
      async *stream() {
        yield { type: "done" };
      },
    },
    modelCatalog: {
      async listModels() {
        discoveryCalls += 1;
        return [descriptor];
      },
    },
    model,
    providers: [
      {
        provider_id: model.provider,
        display_name: "ResearchBox",
        kind: "mock",
        models: [model],
      },
      {
        provider_id: descriptor.provider_id,
        display_name: descriptor.provider_display_name,
        kind: "openai_compatible",
        discover_models: true,
      },
    ],
    systemPrompt: "You are a test agent.",
    eventSink: (event) => events.push(event),
  });

  await core.handle(createCommand("bootstrap", {}));
  await core.handle(
    createCommand("provider_refresh", {
      provider_id: descriptor.provider_id,
    }),
  );
  const callsAfterRecovery = discoveryCalls;
  await core.handle(
    createCommand("provider_refresh", {
      provider_id: descriptor.provider_id,
    }),
  );

  assert.ok(callsAfterRecovery >= 1);
  assert.equal(discoveryCalls, callsAfterRecovery + 1);
  assert.equal(
    latestState(events).providers.find(
      (candidate) => candidate.provider_id === descriptor.provider_id,
    ).availability,
    "ready",
  );
});

test("draft updates during a run survive the finished checkpoint", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let markStarted;
  let releaseTransport;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise((resolve) => {
    releaseTransport = resolve;
  });
  const core = createCore(store, provider, events, {
    async *stream() {
      markStarted();
      await released;
      yield { type: "done" };
    },
  });
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const prompt = core.handle(
    createCommand("prompt", {
      project_id: projectId,
      session_id: null,
      text: "Start a slow response",
    }),
  );
  await started;
  const sessionId = (await store.load()).active_session_id;
  assert.ok(sessionId);
  await core.handle(
    createCommand("input_draft_update", {
      project_id: projectId,
      session_id: null,
      input_draft: "stale virtual draft",
    }),
  );
  assert.equal((await store.load()).projects[0].new_chat_draft, "");
  await core.handle(
    createCommand("input_draft_update", {
      project_id: projectId,
      session_id: null,
      input_draft: "",
    }),
  );
  await core.handle(
    createCommand("input_draft_update", {
      project_id: projectId,
      session_id: sessionId,
      input_draft: "typed while running",
    }),
  );
  releaseTransport();
  await prompt;
  const document = (await store.load()).documents.find(
    (candidate) => candidate.session_id === sessionId,
  );
  assert.equal(document.input_draft, "typed while running");
});

test("abort bypasses catalog serialization and checkpoints a terminal assistant", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const core = createCore(store, provider, events, {
    async *stream(_request, signal) {
      markStarted();
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
      yield { type: "done" };
    },
  });
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const prompt = core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Wait forever",
    }),
  );
  await started;
  const active = latestState(events);
  assert.ok(active.active_session_id);

  await core.handle(
    createCommand("project_update", {
      project_id: active.active_project_id,
      name: "Must not interrupt",
    }),
  );
  assert.equal((await store.load()).projects[0].name, "Local workspace");
  assert.equal(events.at(-1).payload.code, "run_in_progress");
  await core.handle(
    createCommand("abort", {
      project_id: active.active_project_id,
      session_id: active.active_session_id,
    }),
  );
  await prompt;

  const document = (await store.load()).documents[0];
  assert.equal(document.timeline.at(-1).type, "assistant_message");
  assert.equal(document.timeline.at(-1).status, "aborted");
  assert.equal(document.timeline.at(-1).stop_reason, "aborted");
});

test("dispose aborts and drains an active run before it resolves", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const core = createCore(store, provider, events, {
    async *stream(_request, signal) {
      markStarted();
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
      yield { type: "done" };
    },
  });
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const prompt = core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Drain this run",
    }),
  );
  await started;

  await Promise.all([core.dispose(), prompt]);

  const document = (await store.load()).documents[0];
  assert.equal(document.timeline.at(-1).type, "assistant_message");
  assert.equal(document.timeline.at(-1).status, "aborted");
  assert.equal(document.timeline.at(-1).stop_reason, "aborted");
  assert.equal(core.runtime, null);
  await assert.rejects(
    core.handle(createCommand("bootstrap", {})),
    /core is closed/,
  );
});

test("dispose waits for admitted bootstrap work and releases its runtime", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const seedEvents = [];
  const seed = createCore(store, provider, seedEvents);
  await seed.handle(createCommand("bootstrap", {}));
  await seed.dispose();

  let loadCalls = 0;
  let markRefreshStarted;
  let releaseRefresh;
  const refreshStarted = new Promise((resolve) => {
    markRefreshStarted = resolve;
  });
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const delayedStore = {
    async load() {
      loadCalls += 1;
      if (loadCalls === 2) {
        markRefreshStarted();
        await refreshGate;
      }
      return store.load();
    },
    save: (state, expectedRevision) =>
      store.save(state, expectedRevision),
    mutate: (mutation) => store.mutate(mutation),
    saveInputDraft: (update) => store.saveInputDraft(update),
    subscribe: (listener) => store.subscribe(listener),
  };
  const events = [];
  const core = createCore(delayedStore, provider, events);
  const bootstrap = core.handle(createCommand("bootstrap", {}));
  await refreshStarted;

  let disposalFinished = false;
  const disposal = core.dispose().then(() => {
    disposalFinished = true;
  });
  await flushTasks();
  assert.equal(disposalFinished, false);

  releaseRefresh();
  await Promise.all([bootstrap, disposal]);
  assert.equal(disposalFinished, true);
  assert.equal(core.runtime, null);
  assert.equal(events.some((event) => event.type === "ready"), false);
});

test("abort repairs unexecuted sequential tool calls before the next prompt", async () => {
  const store = new MemoryProjectStore();
  const workspace = new MemoryFileSystem({ "/README.md": "# Test" });
  const provider = new MemoryWorkspaceBackend(() => workspace);
  const events = [];
  let markFirstToolStarted;
  let releaseFirstTool;
  const firstToolStarted = new Promise((resolve) => {
    markFirstToolStarted = resolve;
  });
  const firstToolReleased = new Promise((resolve) => {
    releaseFirstTool = resolve;
  });
  const read = workspace.read.bind(workspace);
  workspace.read = async (path) => {
    markFirstToolStarted();
    await firstToolReleased;
    return read(path);
  };

  const requests = [];
  const core = createCore(store, provider, events, {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        yield* toolCallEvents({
          tool_call_id: "read-call",
          tool_name: "read_file",
          arguments: { path: "/README.md" },
        }, 0);
        yield* toolCallEvents({
          tool_call_id: "list-call",
          tool_name: "list_files",
          arguments: { path: "/" },
        }, 1);
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("Recovered");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const firstPrompt = core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Inspect the workspace",
    }),
  );
  await firstToolStarted;
  const active = latestState(events);
  assert.ok(active.active_session_id);

  await core.handle(
    createCommand("abort", {
      project_id: active.active_project_id,
      session_id: active.active_session_id,
    }),
  );
  releaseFirstTool();
  await firstPrompt;

  const afterAbort = (await store.load()).documents[0];
  assert.deepEqual(
    afterAbort.timeline.slice(0, 2).map((entry) => entry.type),
    ["user_message", "assistant_message"],
  );
  assert.equal(afterAbort.timeline[1].status, "complete");
  assert.equal(afterAbort.timeline[1].stop_reason, "tool_use");
  const resultIndexes = afterAbort.timeline.flatMap((entry, index) =>
    entry.type === "tool_result" ? [index] : [],
  );
  assert.equal(resultIndexes.length, 2);
  const laterAssistant = afterAbort.timeline.findIndex(
    (entry, index) => index > 1 && entry.type === "assistant_message",
  );
  assert.equal(
    laterAssistant === -1 || laterAssistant > Math.max(...resultIndexes),
    true,
    "All tool results must precede a terminal assistant entry",
  );
  const skippedResult = afterAbort.timeline.find(
    (entry) =>
      entry.type === "tool_result" && entry.tool_call_id === "list-call",
  );
  assert.ok(skippedResult, "Expected a result for the unexecuted tool call");
  assert.equal(skippedResult.tool_name, "list_files");
  assert.equal(skippedResult.is_error, true);
  assert.equal(
    skippedResult.content,
    "Tool execution was skipped because the run was aborted.",
  );
  const skippedCall = afterAbort.timeline
    .filter((entry) => entry.type === "assistant_message")
    .flatMap((entry) => entry.blocks)
    .find(
      (block) =>
        block.type === "tool_call" && block.tool_call_id === "list-call",
    );
  assert.ok(skippedCall);
  assert.equal(skippedResult.tool_call_block_id, skippedCall.block_id);

  await core.handle(
    createCommand("prompt", {
      project_id: active.active_project_id,
      session_id: active.active_session_id,
      text: "Continue safely",
    }),
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1].messages.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "user"],
  );
  const priorAssistant = requests[1].messages[1];
  assert.deepEqual(
    priorAssistant.content_blocks
      .filter((block) => block.type === "tool_call")
      .map((toolCall) => toolCall.tool_call_id),
    ["read-call", "list-call"],
  );
  assert.deepEqual(
    requests[1].messages.slice(2, 4).map((message) => ({
      tool_call_id: message.tool_call_id,
      is_error: message.is_error,
    })),
    [
      { tool_call_id: "read-call", is_error: false },
      { tool_call_id: "list-call", is_error: true },
    ],
  );
  assert.equal(
    (await store.load()).documents[0].timeline.at(-1).status,
    "complete",
  );
});

test("timeline preserves reasoning, text, tool, result, and final text order across reload", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let requestCount = 0;
  const core = createCore(store, provider, events, {
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        yield* reasoningEvents("I should inspect the workspace.", 0);
        yield* textEvents("I will read the README first.", 1);
        yield* toolCallEvents(
          {
            tool_call_id: "read-readme",
            tool_name: "read_file",
            arguments: { path: "/README.md" },
          },
          2,
        );
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("The README contains the test workspace.", 0);
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Inspect the README",
    }),
  );

  const persistedTimeline = (await store.load()).documents[0].timeline;
  assert.deepEqual(describeTimeline(persistedTimeline), [
    { type: "user_message", content: "Inspect the README" },
    {
      type: "assistant_message",
      status: "complete",
      blocks: [
        { type: "reasoning", text: "I should inspect the workspace." },
        { type: "assistant_text", text: "I will read the README first." },
        {
          type: "tool_call",
          tool_call_id: "read-readme",
          tool_name: "read_file",
        },
      ],
    },
    {
      type: "tool_result",
      tool_call_id: "read-readme",
      tool_name: "read_file",
      is_error: false,
    },
    {
      type: "assistant_message",
      status: "complete",
      blocks: [
        {
          type: "assistant_text",
          text: "The README contains the test workspace.",
        },
      ],
    },
  ]);
  assert.deepEqual(latestState(events).timeline, persistedTimeline);
  const call = persistedTimeline[1].blocks[2];
  const result = persistedTimeline[2];
  assert.equal(result.tool_call_block_id, call.block_id);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));
  assert.deepEqual(latestState(reloadedEvents).timeline, persistedTimeline);
  assert.deepEqual(
    describeTimeline(latestState(reloadedEvents).timeline),
    describeTimeline(persistedTimeline),
  );
});

test("search_files returns bounded structured matches through the agent loop", async () => {
  const store = new MemoryProjectStore();
  const workspace = new MemoryFileSystem({
    "/README.md": "A browser-native workspace.\nUse versioned JSON.",
    "/notes/design.md": "Viewer and core use versioned JSON messages.",
    "/src/agent.ts": "export const runtime = 'browser';",
  });
  const provider = new MemoryWorkspaceBackend(() => workspace);
  const events = [];
  const requests = [];
  const core = createCore(store, provider, events, {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        yield* toolCallEvents(
          {
            tool_call_id: "search-workspace",
            tool_name: "search_files",
            arguments: { path: "/", query: "versioned JSON" },
          },
          0,
        );
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("The search found two matching lines.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Search the workspace",
    }),
  );

  assert.equal(requests.length, 2);
  const searchDefinition = requests[0].tools.find(
    (tool) => tool.name === "search_files",
  );
  assert.deepEqual(searchDefinition?.parameters.required, ["path", "query"]);
  const toolMessage = requests[1].messages.find(
    (message) =>
      message.role === "tool" && message.tool_name === "search_files",
  );
  assert.ok(toolMessage);
  const result = JSON.parse(toolMessage.content);
  assert.deepEqual(result, {
    workspace_revision: 0,
    path: "/",
    query: "versioned JSON",
    matches: [
      {
        path: "/README.md",
        line_number: 2,
        column_number: 5,
        preview: "Use versioned JSON.",
      },
      {
        path: "/notes/design.md",
        line_number: 1,
        column_number: 21,
        preview: "Viewer and core use versioned JSON messages.",
      },
    ],
    files_scanned: 3,
    truncated: false,
  });

  const timeline = (await store.load()).documents[0].timeline;
  const toolCall = timeline
    .filter((entry) => entry.type === "assistant_message")
    .flatMap((entry) => entry.blocks)
    .find(
      (block) =>
        block.type === "tool_call" &&
        block.tool_call_id === "search-workspace",
    );
  assert.equal(toolCall?.label, "Searching /");
  const toolResult = timeline.find(
    (entry) =>
      entry.type === "tool_result" &&
      entry.tool_call_id === "search-workspace",
  );
  assert.equal(toolResult?.summary, "2 matches in 3 files");
  assert.equal(toolResult?.is_error, false);
});

test("overlapping tool calls keep start order and block identities when ends interleave", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let requestCount = 0;
  const firstCall = {
    tool_call_id: "read-first",
    tool_name: "read_file",
    arguments: { path: "/README.md" },
  };
  const secondCall = {
    tool_call_id: "list-second",
    tool_name: "list_files",
    arguments: { path: "/" },
  };
  const core = createCore(store, provider, events, {
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: "tool_call_start", content_index: 0 };
        yield { type: "tool_call_start", content_index: 1 };
        yield {
          type: "tool_call_delta",
          content_index: 0,
          tool_call_id_delta: firstCall.tool_call_id,
          tool_name_delta: firstCall.tool_name,
          arguments_delta: JSON.stringify(firstCall.arguments),
        };
        yield {
          type: "tool_call_delta",
          content_index: 1,
          tool_call_id_delta: secondCall.tool_call_id,
          tool_name_delta: secondCall.tool_name,
          arguments_delta: JSON.stringify(secondCall.arguments),
        };
        yield {
          type: "tool_call_end",
          content_index: 1,
          tool_call: secondCall,
        };
        yield {
          type: "tool_call_end",
          content_index: 0,
          tool_call: firstCall,
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("Inspection complete.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Inspect the workspace",
    }),
  );

  const reordered = events.find(
    (event) =>
      event.type === "timeline_entry_updated" &&
      event.payload.entry.type === "assistant_message" &&
      event.payload.entry.status === "streaming" &&
      event.payload.entry.blocks.length === 2,
  );
  assert.ok(reordered, "Expected a live snapshot after canonical reordering");
  assert.deepEqual(
    reordered.payload.entry.blocks.map((block) => block.tool_call_id),
    ["read-first", "list-second"],
  );

  const timeline = (await store.load()).documents[0].timeline;
  const assistant = timeline.find(
    (entry) =>
      entry.type === "assistant_message" &&
      entry.blocks.some((block) => block.type === "tool_call"),
  );
  assert.ok(assistant);
  assert.deepEqual(
    assistant.blocks.map((block) => block.tool_call_id),
    ["read-first", "list-second"],
  );
  assert.deepEqual(
    assistant.blocks.map((block) => block.block_id),
    reordered.payload.entry.blocks.map((block) => block.block_id),
  );

  const results = timeline.filter((entry) => entry.type === "tool_result");
  assert.deepEqual(
    results.map((result) => ({
      tool_call_id: result.tool_call_id,
      tool_call_block_id: result.tool_call_block_id,
    })),
    assistant.blocks.map((block) => ({
      tool_call_id: block.tool_call_id,
      tool_call_block_id: block.block_id,
    })),
  );
});

test("fragmented tool-call failures persist no incomplete tool block and recover", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const requests = [];
  const core = createCore(store, provider, events, {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        yield { type: "tool_call_start", content_index: 0 };
        yield {
          type: "tool_call_delta",
          content_index: 0,
          tool_call_id_delta: "unfinished-",
          tool_name_delta: "write_",
          arguments_delta: "{\"path\":\"/notes.md\"",
        };
        throw new Error("Connection lost during tool call");
      }
      yield* textEvents("Recovered");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Start a tool call",
    }),
  );

  const failedDocument = (await store.load()).documents[0];
  assert.deepEqual(
    failedDocument.timeline.map((entry) => entry.type),
    ["user_message", "assistant_message"],
  );
  const failedAssistant = failedDocument.timeline[1];
  assert.equal(failedAssistant.status, "error");
  assert.equal(failedAssistant.stop_reason, "error");
  assert.match(failedAssistant.error_message, /Connection lost/);
  assert.deepEqual(failedAssistant.blocks, []);

  const failedState = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: failedState.active_project_id,
      session_id: failedState.active_session_id,
      text: "Continue safely",
    }),
  );

  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].messages.some((message) =>
      message.role === "assistant" &&
      message.content_blocks.some((block) => block.type === "tool_call")
    ),
    false,
  );
  assert.equal(
    (await store.load()).documents[0].timeline.at(-1).status,
    "complete",
  );
});

test("workspace mutation tools persist receipts and emit live change events", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const requests = [];
  const initialContent = "# Agent note\n\nfirst draft\n";
  const finalContent = "# Agent note\n\nready to review\n";
  const core = createCore(store, provider, events, {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        yield* toolCallEvents({
          tool_call_id: "write-note",
          tool_name: "write_file",
          arguments: {
            path: "/notes/agent-note.md",
            content: initialContent,
          },
        });
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      if (requests.length === 2) {
        const writeResult = request.messages.at(-1);
        assert.equal(writeResult.role, "tool");
        assert.equal(writeResult.tool_call_id, "write-note");
        assert.equal(writeResult.tool_name, "write_file");
        assert.equal(writeResult.is_error, false);
        yield* toolCallEvents({
          tool_call_id: "revise-note",
          tool_name: "replace_text",
          arguments: {
            path: "/notes/agent-note.md",
            old_text: "first draft",
            new_text: "ready to review",
          },
        });
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      if (requests.length === 3) {
        const replaceResult = request.messages.at(-1);
        assert.equal(replaceResult.role, "tool");
        assert.equal(replaceResult.tool_call_id, "revise-note");
        assert.equal(replaceResult.tool_name, "replace_text");
        assert.equal(replaceResult.is_error, false);
        yield* toolCallEvents({
          tool_call_id: "remove-note",
          tool_name: "remove_file",
          arguments: {
            path: "/notes/agent-note.md",
          },
        });
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      const removeResult = request.messages.at(-1);
      assert.equal(removeResult.role, "tool");
      assert.equal(removeResult.tool_call_id, "remove-note");
      assert.equal(removeResult.tool_name, "remove_file");
      assert.equal(removeResult.is_error, false);
      yield* textEvents("The note was removed.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  assert.equal(initial.workspace_revision, 0);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Create, revise, and remove a note",
    }),
  );

  const workspace = await provider.open(initial.active_project_id);
  await assert.rejects(
    workspace.read("/notes/agent-note.md"),
    (error) => error?.code === "not_found",
  );
  const { changes } = await workspace.listChanges();
  assert.equal(changes.length, 3);
  assert.deepEqual(
    changes.map((change) => ({
      tool_call_id: change.tool_call_id,
      tool_name: change.tool_name,
      path: change.path,
      change_kind: change.change_kind,
      before_content: change.before_content,
      after_content: change.after_content,
    })),
    [
      {
        tool_call_id: "write-note",
        tool_name: "write_file",
        path: "/notes/agent-note.md",
        change_kind: "created",
        before_content: null,
        after_content: initialContent,
      },
      {
        tool_call_id: "revise-note",
        tool_name: "replace_text",
        path: "/notes/agent-note.md",
        change_kind: "updated",
        before_content: initialContent,
        after_content: finalContent,
      },
      {
        tool_call_id: "remove-note",
        tool_name: "remove_file",
        path: "/notes/agent-note.md",
        change_kind: "deleted",
        before_content: finalContent,
        after_content: null,
      },
    ],
  );

  const changeEvents = events.filter(
    (event) => event.type === "workspace_changed",
  );
  assert.deepEqual(
    changeEvents.map((event) => ({
      workspace_revision: event.payload.workspace_revision,
      tool_call_id: event.payload.change.tool_call_id,
      path: event.payload.change.path,
    })),
    [
      {
        workspace_revision: 1,
        tool_call_id: "write-note",
        path: "/notes/agent-note.md",
      },
      {
        workspace_revision: 2,
        tool_call_id: "revise-note",
        path: "/notes/agent-note.md",
      },
      {
        workspace_revision: 3,
        tool_call_id: "remove-note",
        path: "/notes/agent-note.md",
      },
    ],
  );

  const persisted = await store.load();
  const toolResults = persisted.documents[0].timeline.filter(
    (entry) => entry.type === "tool_result",
  );
  assert.deepEqual(
    toolResults.map((entry) => ({
      tool_call_id: entry.tool_call_id,
      is_error: entry.is_error,
      path: entry.file_change?.path,
      summary: entry.summary,
    })),
    [
      {
        tool_call_id: "write-note",
        is_error: false,
        path: "/notes/agent-note.md",
        summary: "Created · +3 −0",
      },
      {
        tool_call_id: "revise-note",
        is_error: false,
        path: "/notes/agent-note.md",
        summary: "Updated · +1 −1",
      },
      {
        tool_call_id: "remove-note",
        is_error: false,
        path: "/notes/agent-note.md",
        summary: "Deleted · +0 −3",
      },
    ],
  );
  assert.equal(toolResults.length, 3);
  for (const result of toolResults) {
    const toolCall = persisted.documents[0].timeline
      .filter((entry) => entry.type === "assistant_message")
      .flatMap((entry) => entry.blocks)
      .find((block) => block.block_id === result.tool_call_block_id);
    assert.ok(toolCall, "Tool results must reference an internal call block");
    assert.equal(toolCall.tool_call_id, result.tool_call_id);
  }
  assert.equal(latestState(events).workspace_revision, 3);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));
  assert.equal(latestState(reloadedEvents).workspace_revision, 3);
  assert.equal(
    latestState(reloadedEvents).timeline.filter(
      (entry) => entry.type === "tool_result",
    ).length,
    3,
  );
  assert.equal(
    latestState(reloadedEvents).timeline.every(
      (entry) => entry.type !== "assistant_message" || entry.status === "complete",
    ),
    true,
  );
  await assert.rejects(
    workspace.read("/notes/agent-note.md"),
    (error) => error?.code === "not_found",
  );
});

test("reads coherent workspace change details from an inactive project", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const firstProjectId = latestState(events).active_project_id;
  const firstWorkspace = await provider.open(firstProjectId);
  const changed = await firstWorkspace.write(
    "/README.md",
    "# Reviewed\n",
    {
      change: createWorkspaceChangeMetadata("inactive-change"),
    },
  );
  const receipt = changed.result.change;
  assert.ok(receipt);

  await core.handle(createCommand("project_create", { name: "Second" }));
  const activeProjectId = latestState(events).active_project_id;
  assert.notEqual(activeProjectId, firstProjectId);

  const command = createCommand("workspace_change_read", {
    project_id: firstProjectId,
    change_id: receipt.change_id,
  });
  await core.handle(command);

  const snapshot = events.at(-1);
  assert.equal(snapshot.type, "workspace_change_snapshot");
  assert.equal(snapshot.request_id, command.request_id);
  assert.equal(snapshot.payload.project_id, firstProjectId);
  assert.equal(snapshot.payload.workspace_revision, changed.workspace_revision);
  assert.deepEqual(snapshot.payload.change, {
    change_id: receipt.change_id,
    tool_call_id: receipt.tool_call_id,
    tool_name: "write_file",
    path: receipt.path,
    change_kind: "updated",
    additions: receipt.additions,
    deletions: receipt.deletions,
    byte_size: receipt.byte_size,
    before_content: "# Test",
    after_content: "# Reviewed\n",
    current_content: "# Reviewed\n",
    reverted_at_workspace_revision: null,
    revert_status: "available",
  });
  assert.equal(latestState(events).active_project_id, activeProjectId);

  for (const type of [
    "workspace_change_read",
    "workspace_change_revert",
  ]) {
    const missing = createCommand(type, {
      project_id: firstProjectId,
      change_id: "missing-change",
    });
    await core.handle(missing);
    assert.equal(events.at(-1).type, "error");
    assert.equal(events.at(-1).request_id, missing.request_id);
    assert.equal(
      events.at(-1).payload.code,
      "workspace_change_not_found",
    );
    assert.equal(events.at(-1).payload.project_id, firstProjectId);
  }
});

test("change inspection rejects a receipt for another requested change", async () => {
  const filesystem = new MemoryFileSystem({
    "/notes.txt": "before",
  });
  const provider = new MemoryWorkspaceBackend(() => filesystem);
  const store = new MemoryProjectStore();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const workspace = await provider.open(projectId);
  const write = await workspace.write("/notes.txt", "after", {
    change: createWorkspaceChangeMetadata("inspection-change"),
  });
  const receipt = write.result.change;
  assert.ok(receipt);

  const getChange = filesystem.getChange.bind(filesystem);
  filesystem.getChange = async (changeId) => {
    const result = await getChange(changeId);
    return {
      ...result,
      change:
        result.change === null
          ? null
          : {
              ...result.change,
              change_id: "different-change",
            },
    };
  };

  const command = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(command);

  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).request_id, command.request_id);
  assert.equal(
    events.at(-1).payload.code,
    "workspace_change_read_failed",
  );
  assert.match(
    events.at(-1).payload.message,
    /different change receipt/,
  );
});

test("reverts a created file and treats repeated reverts as success", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const workspace = await provider.open(projectId);
  const write = await workspace.write("/created.txt", "created\n", {
    change: createWorkspaceChangeMetadata("created-change"),
  });
  const receipt = write.result.change;
  assert.ok(receipt);

  const first = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(first);
  const reverted = events.at(-1);
  assert.deepEqual(reverted, {
    protocol_version: reverted.protocol_version,
    event_id: reverted.event_id,
    request_id: first.request_id,
    type: "workspace_change_reverted",
    payload: {
      project_id: projectId,
      change_id: receipt.change_id,
      path: "/created.txt",
      change_kind: "created",
      tool_name: "write_file",
      workspace_revision: 2,
      reverted_at_workspace_revision: 2,
      revert_outcome: "applied",
    },
  });
  await assert.rejects(
    workspace.read("/created.txt"),
    (error) => error?.code === "not_found",
  );

  const repeated = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(repeated);
  assert.equal(events.at(-1).type, "workspace_change_reverted");
  assert.equal(events.at(-1).request_id, repeated.request_id);
  assert.equal(events.at(-1).payload.workspace_revision, 2);
  assert.equal(
    events.at(-1).payload.reverted_at_workspace_revision,
    2,
  );
  assert.equal(
    events.at(-1).payload.revert_outcome,
    "already_reverted",
  );

  const read = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(read);
  assert.equal(events.at(-1).payload.change.current_content, null);
  assert.equal(
    events.at(-1).payload.change.reverted_at_workspace_revision,
    2,
  );
  assert.equal(
    events.at(-1).payload.change.revert_status,
    "already_reverted",
  );
  assert.equal(events.at(-1).payload.workspace_revision, 2);
  assert.equal((await workspace.listChanges()).changes.length, 1);

  await workspace.write("/created.txt", "created\n");
  const replayAfterRecreation = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(replayAfterRecreation);
  assert.equal(events.at(-1).type, "workspace_change_reverted");
  assert.equal(
    events.at(-1).payload.revert_outcome,
    "already_reverted",
  );
  assert.equal(events.at(-1).payload.workspace_revision, 3);
  assert.equal(
    events.at(-1).payload.reverted_at_workspace_revision,
    2,
  );
  assert.equal((await workspace.read("/created.txt")).content, "created\n");
});

test("reverts an updated file and preserves an empty original exactly", async () => {
  const filesystem = new MemoryFileSystem({ "/empty.txt": "" });
  const provider = new MemoryWorkspaceBackend(() => filesystem);
  const store = new MemoryProjectStore();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const workspace = await provider.open(projectId);
  const write = await workspace.write("/empty.txt", "filled", {
    change: createWorkspaceChangeMetadata("updated-change"),
  });
  const receipt = write.result.change;
  assert.ok(receipt);

  const first = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(first);
  assert.equal(events.at(-1).type, "workspace_change_reverted");
  assert.equal(events.at(-1).payload.change_kind, "updated");
  assert.equal(events.at(-1).payload.workspace_revision, 2);
  assert.equal(events.at(-1).payload.revert_outcome, "applied");
  assert.equal((await workspace.read("/empty.txt")).content, "");

  const repeated = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(repeated);
  assert.equal(events.at(-1).type, "workspace_change_reverted");
  assert.equal(events.at(-1).payload.workspace_revision, 2);
  assert.equal(
    events.at(-1).payload.revert_outcome,
    "already_reverted",
  );

  const read = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(read);
  assert.equal(events.at(-1).payload.change.before_content, "");
  assert.equal(events.at(-1).payload.change.current_content, "");
  assert.equal(
    events.at(-1).payload.change.reverted_at_workspace_revision,
    2,
  );
  assert.equal(
    events.at(-1).payload.change.revert_status,
    "already_reverted",
  );
});

test("reads and reverts deletion only at its exact missing generation", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const workspace = await provider.open(projectId);

  await workspace.write("/deleted.txt", "restore me\n");
  const removal = await workspace.remove("/deleted.txt", {
    expected_content: "restore me\n",
    change: createWorkspaceChangeMetadata(
      "deleted-change",
      "remove_file",
    ),
  });
  const receipt = removal.result?.change;
  assert.ok(receipt);
  assert.equal(removal.workspace_revision, 2);

  const read = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(read);
  const snapshot = events.at(-1);
  assert.equal(snapshot.type, "workspace_change_snapshot");
  assert.deepEqual(
    {
      tool_name: snapshot.payload.change.tool_name,
      change_kind: snapshot.payload.change.change_kind,
      before_content: snapshot.payload.change.before_content,
      after_content: snapshot.payload.change.after_content,
      current_content: snapshot.payload.change.current_content,
      revert_status: snapshot.payload.change.revert_status,
    },
    {
      tool_name: "remove_file",
      change_kind: "deleted",
      before_content: "restore me\n",
      after_content: null,
      current_content: null,
      revert_status: "available",
    },
  );

  const revert = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(revert);
  assert.equal(events.at(-1).type, "workspace_change_reverted");
  assert.equal(events.at(-1).payload.tool_name, "remove_file");
  assert.equal(events.at(-1).payload.change_kind, "deleted");
  assert.equal(events.at(-1).payload.workspace_revision, 3);
  assert.equal(events.at(-1).payload.revert_outcome, "applied");
  assert.equal(
    (await workspace.read("/deleted.txt")).content,
    "restore me\n",
  );

  const repeated = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(repeated);
  assert.equal(events.at(-1).type, "workspace_change_reverted");
  assert.equal(
    events.at(-1).payload.revert_outcome,
    "already_reverted",
  );
  assert.equal(events.at(-1).payload.workspace_revision, 3);

  await workspace.write("/aba.txt", "same bytes");
  const abaRemoval = await workspace.remove("/aba.txt", {
    expected_content: "same bytes",
    change: createWorkspaceChangeMetadata(
      "deleted-aba",
      "remove_file",
    ),
  });
  const abaReceipt = abaRemoval.result?.change;
  assert.ok(abaReceipt);
  await workspace.write("/aba.txt", "same bytes");
  await workspace.remove("/aba.txt", { expected_content: "same bytes" });

  const inspectAba = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: abaReceipt.change_id,
  });
  await core.handle(inspectAba);
  assert.equal(events.at(-1).type, "workspace_change_snapshot");
  assert.equal(
    events.at(-1).payload.change.revert_status,
    "conflict",
  );
  assert.equal(events.at(-1).payload.change.current_content, null);

  const revertAba = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: abaReceipt.change_id,
  });
  await core.handle(revertAba);
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).payload.code, "workspace_change_conflict");
  await assert.rejects(
    workspace.read("/aba.txt"),
    (error) => error?.code === "not_found",
  );
});

test("revert preflight rejects malformed or mismatched receipts without delegating", async (t) => {
  const cases = [
    {
      name: "malformed receipt",
      corrupt: (change) => ({
        ...change,
        change_kind: "removed",
      }),
    },
    {
      name: "mismatched receipt id",
      corrupt: (change) => ({
        ...change,
        change_id: "different-change",
      }),
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const filesystem = new MemoryFileSystem({
        "/notes.txt": "before",
      });
      const provider = new MemoryWorkspaceBackend(() => filesystem);
      const store = new MemoryProjectStore();
      const events = [];
      const core = createCore(store, provider, events);
      await core.handle(createCommand("bootstrap", {}));
      const projectId = latestState(events).active_project_id;
      const workspace = await provider.open(projectId);
      const write = await workspace.write("/notes.txt", "after", {
        change: createWorkspaceChangeMetadata("preflight-change"),
      });
      const receipt = write.result.change;
      assert.ok(receipt);

      const getChange = filesystem.getChange.bind(filesystem);
      filesystem.getChange = async (changeId) => {
        const result = await getChange(changeId);
        return {
          ...result,
          change:
            result.change === null
              ? null
              : testCase.corrupt(result.change),
        };
      };
      const revertChange = filesystem.revertChange.bind(filesystem);
      let revertCalls = 0;
      filesystem.revertChange = async (changeId) => {
        revertCalls += 1;
        return revertChange(changeId);
      };

      const command = createCommand("workspace_change_revert", {
        project_id: projectId,
        change_id: receipt.change_id,
      });
      await core.handle(command);

      assert.equal(revertCalls, 0);
      assert.equal(events.at(-1).type, "error");
      assert.equal(events.at(-1).request_id, command.request_id);
      assert.equal(
        events.at(-1).payload.code,
        "workspace_change_revert_failed",
      );
      assert.equal(
        (await filesystem.read("/notes.txt")).content,
        "after",
      );
    });
  }
});

test("reports conflicts without overwriting newer content or directories", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const workspace = await provider.open(projectId);

  const updated = await workspace.write("/README.md", "# Agent version", {
    change: createWorkspaceChangeMetadata("conflicted-update"),
  });
  const updatedReceipt = updated.result.change;
  assert.ok(updatedReceipt);
  await workspace.write("/README.md", "# User version");

  const inspectUpdated = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: updatedReceipt.change_id,
  });
  await core.handle(inspectUpdated);
  assert.equal(events.at(-1).payload.change.current_content, "# User version");
  assert.equal(events.at(-1).payload.change.revert_status, "conflict");

  const revertUpdated = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: updatedReceipt.change_id,
  });
  await core.handle(revertUpdated);
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).request_id, revertUpdated.request_id);
  assert.equal(events.at(-1).payload.code, "workspace_change_conflict");
  assert.equal((await workspace.read("/README.md")).content, "# User version");
  const revisionAfterConflict = (await workspace.read("/README.md"))
    .workspace_revision;

  const created = await workspace.write("/former-file", "agent", {
    change: createWorkspaceChangeMetadata("directory-conflict"),
  });
  const createdReceipt = created.result.change;
  assert.ok(createdReceipt);
  await workspace.remove("/former-file", { expected_content: "agent" });
  await workspace.write("/former-file/child.txt", "keep");

  const inspectDirectory = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: createdReceipt.change_id,
  });
  await core.handle(inspectDirectory);
  assert.equal(events.at(-1).payload.change.current_content, null);
  assert.equal(events.at(-1).payload.change.revert_status, "conflict");

  const revertDirectory = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: createdReceipt.change_id,
  });
  await core.handle(revertDirectory);
  assert.equal(events.at(-1).payload.code, "workspace_change_conflict");
  assert.equal(
    (await workspace.read("/former-file/child.txt")).content,
    "keep",
  );
  assert.equal(
    (await workspace.read("/former-file/child.txt")).workspace_revision,
    revisionAfterConflict + 3,
  );
});

test("retries inspection until receipt and current content share a revision", async () => {
  const filesystem = new MemoryFileSystem({ "/README.md": "# Test" });
  const provider = new MemoryWorkspaceBackend(() => filesystem);
  const store = new MemoryProjectStore();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const workspace = await provider.open(projectId);
  const write = await workspace.write("/README.md", "# Agent", {
    change: createWorkspaceChangeMetadata("inspection-race"),
  });
  const receipt = write.result.change;
  assert.ok(receipt);

  const getChange = filesystem.getChange.bind(filesystem);
  let getChangeCalls = 0;
  filesystem.getChange = async (changeId) => {
    getChangeCalls += 1;
    if (getChangeCalls === 2) {
      await filesystem.write("/README.md", "# Concurrent");
    }
    return getChange(changeId);
  };

  const command = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(command);

  assert.equal(getChangeCalls, 4);
  assert.equal(events.at(-1).type, "workspace_change_snapshot");
  assert.equal(events.at(-1).payload.workspace_revision, 2);
  assert.equal(events.at(-1).payload.change.current_content, "# Concurrent");
  assert.equal(events.at(-1).payload.change.revert_status, "conflict");
});

test("edit-away and edit-back ABA cannot make an old receipt revertible", async () => {
  const filesystem = new MemoryFileSystem({ "/README.md": "# Test" });
  const provider = new MemoryWorkspaceBackend(() => filesystem);
  const store = new MemoryProjectStore();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const workspace = await provider.open(projectId);
  const write = await workspace.write("/README.md", "# Agent", {
    change: createWorkspaceChangeMetadata("cas-race"),
  });
  const receipt = write.result.change;
  assert.ok(receipt);

  await workspace.write("/README.md", "# Concurrent");
  await workspace.write("/README.md", "# Agent");

  const inspect = createCommand("workspace_change_read", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(inspect);
  assert.equal(events.at(-1).type, "workspace_change_snapshot");
  assert.equal(events.at(-1).payload.change.current_content, "# Agent");
  assert.equal(events.at(-1).payload.change.revert_status, "conflict");
  assert.equal(
    events.at(-1).payload.change.reverted_at_workspace_revision,
    null,
  );

  const command = createCommand("workspace_change_revert", {
    project_id: projectId,
    change_id: receipt.change_id,
  });
  await core.handle(command);

  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).request_id, command.request_id);
  assert.equal(events.at(-1).payload.code, "workspace_change_conflict");
  assert.equal((await workspace.read("/README.md")).content, "# Agent");
  assert.equal(
    (await workspace.read("/README.md")).workspace_revision,
    3,
  );
});

test("active runs block same-project reverts but not inactive projects", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const core = createCore(store, provider, events, {
    async *stream(_request, signal) {
      markStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
      yield { type: "done" };
    },
  });
  await core.handle(createCommand("bootstrap", {}));
  const inactiveProjectId = latestState(events).active_project_id;
  const inactiveWorkspace = await provider.open(inactiveProjectId);
  const inactiveWrite = await inactiveWorkspace.write(
    "/inactive.txt",
    "agent",
    {
      change: createWorkspaceChangeMetadata("inactive-run-change"),
    },
  );
  const inactiveReceipt = inactiveWrite.result.change;
  assert.ok(inactiveReceipt);

  await core.handle(createCommand("project_create", { name: "Active run" }));
  const active = latestState(events);
  const activeWorkspace = await provider.open(active.active_project_id);
  const activeWrite = await activeWorkspace.write("/active.txt", "agent", {
    change: createWorkspaceChangeMetadata("active-run-change"),
  });
  const activeReceipt = activeWrite.result.change;
  assert.ok(activeReceipt);

  const prompt = core.handle(
    createCommand("prompt", {
      project_id: active.active_project_id,
      session_id: null,
      text: "Keep running",
    }),
  );
  await started;

  const read = createCommand("workspace_change_read", {
    project_id: active.active_project_id,
    change_id: activeReceipt.change_id,
  });
  await core.handle(read);
  assert.equal(events.at(-1).type, "workspace_change_snapshot");
  assert.equal(events.at(-1).request_id, read.request_id);

  const inactiveRevert = createCommand("workspace_change_revert", {
    project_id: inactiveProjectId,
    change_id: inactiveReceipt.change_id,
  });
  await core.handle(inactiveRevert);
  assert.equal(events.at(-1).type, "workspace_change_reverted");
  assert.equal(events.at(-1).request_id, inactiveRevert.request_id);
  assert.equal(events.at(-1).payload.project_id, inactiveProjectId);
  assert.equal(events.at(-1).payload.revert_outcome, "applied");
  await assert.rejects(
    inactiveWorkspace.read("/inactive.txt"),
    (error) => error?.code === "not_found",
  );

  const revert = createCommand("workspace_change_revert", {
    project_id: active.active_project_id,
    change_id: activeReceipt.change_id,
  });
  await core.handle(revert);
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).request_id, revert.request_id);
  assert.equal(events.at(-1).payload.code, "run_in_progress");
  assert.equal((await activeWorkspace.read("/active.txt")).content, "agent");

  const running = latestState(events);
  await core.handle(
    createCommand("abort", {
      project_id: running.active_project_id,
      session_id: running.active_session_id,
    }),
  );
  await prompt;
});

test("core snapshots use backend revisions for unjournaled mutations", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const workspace = await provider.open(projectId);

  const write = await workspace.write("/temporary.txt", "temporary");
  assert.equal(write.workspace_revision, 1);
  const remove = await workspace.remove("/temporary.txt", {
    expected_content: "temporary",
  });
  assert.equal(remove.workspace_revision, 2);
  assert.deepEqual(await workspace.listChanges(), {
    workspace_revision: 2,
    changes: [],
  });

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));
  const snapshot = latestState(reloadedEvents);
  assert.equal(snapshot.workspace_revision, 2);
  assert.equal(
    snapshot.files.some((entry) => entry.path === "/temporary.txt"),
    false,
  );
});

test("reload recovers a committed mutation from its durable receipt", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let requestCount = 0;
  const core = createCore(store, provider, events, {
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        yield* toolCallEvents({
          tool_call_id: "recover-write",
          tool_name: "write_file",
          arguments: {
            path: "/recovered.txt",
            content: "committed before reload\n",
          },
        });
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("Saved.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Write a recoverable file",
    }),
  );

  const crashed = await store.load();
  const document = crashed.documents[0];
  assert.deepEqual(
    document.timeline.map((entry) => entry.type),
    ["user_message", "assistant_message", "tool_result", "assistant_message"],
  );
  const toolBlock = document.timeline[1].blocks[0];
  assert.equal(toolBlock.type, "tool_call");
  document.timeline = document.timeline.slice(0, 2);
  const expectedRevision = crashed.state_revision;
  crashed.state_revision += 1;
  await store.save(crashed, expectedRevision);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));

  const recovered = (await store.load()).documents[0];
  assert.deepEqual(
    recovered.timeline.map((entry) => entry.type),
    ["user_message", "assistant_message", "tool_result"],
  );
  const recoveredResult = recovered.timeline.at(-1);
  assert.equal(recoveredResult.tool_call_id, "recover-write");
  assert.equal(recoveredResult.tool_call_block_id, toolBlock.block_id);
  assert.equal(recoveredResult.is_error, false);
  assert.deepEqual(
    {
      summary: recoveredResult.summary,
      path: recoveredResult.file_change?.path,
      change_kind: recoveredResult.file_change?.change_kind,
    },
    {
      summary: "Created · +1 −0",
      path: "/recovered.txt",
      change_kind: "created",
    },
  );
  assert.equal(
    (
      await (await provider.open(initial.active_project_id)).read(
        "/recovered.txt",
      )
    ).content,
    "committed before reload\n",
  );
});

test("reload recovers a committed deletion from its durable receipt", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let requestCount = 0;
  const core = createCore(store, provider, events, {
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        yield* toolCallEvents({
          tool_call_id: "recover-remove",
          tool_name: "remove_file",
          arguments: { path: "/README.md" },
        });
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("Removed.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Remove the README",
    }),
  );

  const crashed = await store.load();
  const document = crashed.documents[0];
  const toolBlock = document.timeline[1].blocks[0];
  assert.equal(toolBlock.type, "tool_call");
  assert.equal(toolBlock.tool_name, "remove_file");
  document.timeline = document.timeline.slice(0, 2);
  const expectedRevision = crashed.state_revision;
  crashed.state_revision += 1;
  await store.save(crashed, expectedRevision);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));

  const recovered = (await store.load()).documents[0];
  assert.deepEqual(
    recovered.timeline.map((entry) => entry.type),
    ["user_message", "assistant_message", "tool_result"],
  );
  const recoveredResult = recovered.timeline.at(-1);
  assert.deepEqual(
    {
      tool_call_id: recoveredResult.tool_call_id,
      tool_call_block_id: recoveredResult.tool_call_block_id,
      tool_name: recoveredResult.tool_name,
      is_error: recoveredResult.is_error,
      summary: recoveredResult.summary,
      path: recoveredResult.file_change?.path,
      change_kind: recoveredResult.file_change?.change_kind,
    },
    {
      tool_call_id: "recover-remove",
      tool_call_block_id: toolBlock.block_id,
      tool_name: "remove_file",
      is_error: false,
      summary: "Deleted · +0 −1",
      path: "/README.md",
      change_kind: "deleted",
    },
  );
  await assert.rejects(
    (await provider.open(initial.active_project_id)).read("/README.md"),
    (error) => error?.code === "not_found",
  );
});

test("reload matches a legacy mutation receipt by migrated message identity", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let requestCount = 0;
  const core = createCore(store, provider, events, {
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        yield* toolCallEvents({
          tool_call_id: "legacy-recover-write",
          tool_name: "write_file",
          arguments: {
            path: "/legacy-recovered.txt",
            content: "legacy receipt\n",
          },
        });
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("Saved.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Write a recoverable legacy file",
    }),
  );

  const crashed = await store.load();
  const document = crashed.documents[0];
  const assistant = document.timeline[1];
  assert.equal(assistant.type, "assistant_message");
  document.timeline = document.timeline.slice(0, 2);
  const expectedRevision = crashed.state_revision;
  crashed.state_revision += 1;
  await store.save(crashed, expectedRevision);

  const workspace = await provider.open(initial.active_project_id);
  const listChanges = workspace.listChanges.bind(workspace);
  workspace.listChanges = async () => {
    const journal = await listChanges();
    return {
      ...journal,
      changes: journal.changes.map((record) => ({
        ...record,
        tool_call_block_id: null,
        legacy_message_id: assistant.entry_id,
        assistant_message_index: 999,
      })),
    };
  };

  const reloaded = createCore(store, provider, []);
  await reloaded.handle(createCommand("bootstrap", {}));

  const recovered = (await store.load()).documents[0].timeline.at(-1);
  assert.equal(recovered.type, "tool_result");
  assert.equal(recovered.tool_call_id, "legacy-recover-write");
  assert.equal(recovered.is_error, false);
  assert.equal(recovered.file_change?.path, "/legacy-recovered.txt");
});

test("reload recovers a later sequential mutation after prior tool results", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let requestCount = 0;
  const core = createCore(store, provider, events, {
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        yield* toolCallEvents({
          tool_call_id: "first-write",
          tool_name: "write_file",
          arguments: {
            path: "/first.txt",
            content: "first\n",
          },
        }, 0);
        yield* toolCallEvents({
          tool_call_id: "second-write",
          tool_name: "write_file",
          arguments: {
            path: "/second.txt",
            content: "second\n",
          },
        }, 1);
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("Both files are saved.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Write two files",
    }),
  );

  const crashed = await store.load();
  const document = crashed.documents[0];
  const assistant = document.timeline[1];
  assert.equal(assistant.type, "assistant_message");
  const toolBlocks = assistant.blocks.filter(
    (block) => block.type === "tool_call",
  );
  assert.equal(toolBlocks.length, 2);
  assert.deepEqual(
    toolBlocks.map((block) => block.tool_call_id),
    ["first-write", "second-write"],
  );
  assert.notEqual(toolBlocks[0].block_id, toolBlocks[1].block_id);
  assert.deepEqual(
    document.timeline.map((entry) => entry.type),
    [
      "user_message",
      "assistant_message",
      "tool_result",
      "tool_result",
      "assistant_message",
    ],
  );
  document.timeline = document.timeline.slice(0, 3);
  const expectedRevision = crashed.state_revision;
  crashed.state_revision += 1;
  await store.save(crashed, expectedRevision);

  const reloaded = createCore(store, provider, []);
  await reloaded.handle(createCommand("bootstrap", {}));

  const recovered = (await store.load()).documents[0];
  assert.deepEqual(
    recovered.timeline.map((entry) => entry.type),
    ["user_message", "assistant_message", "tool_result", "tool_result"],
  );
  const secondResult = recovered.timeline.at(-1);
  assert.deepEqual(
    {
      tool_call_id: secondResult.tool_call_id,
      tool_call_block_id: secondResult.tool_call_block_id,
      is_error: secondResult.is_error,
      path: secondResult.file_change?.path,
    },
    {
      tool_call_id: "second-write",
      tool_call_block_id: toolBlocks[1].block_id,
      is_error: false,
      path: "/second.txt",
    },
  );
});

test("reload never reuses an old receipt for a repeated provider tool id", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let requestCount = 0;
  const core = createCore(store, provider, events, {
    async *stream() {
      requestCount += 1;
      if (requestCount <= 2) {
        yield* toolCallEvents({
          tool_call_id: "reused-write-id",
          tool_name: "write_file",
          arguments: {
            path: "/same.txt",
            content: "same content\n",
          },
        });
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("No further changes.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Write the same content twice",
    }),
  );

  const workspace = await provider.open(initial.active_project_id);
  const { changes } = await workspace.listChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].assistant_message_index, 1);

  const crashed = await store.load();
  const document = crashed.documents[0];
  assert.deepEqual(
    document.timeline.map((entry) => entry.type),
    [
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
      "tool_result",
      "assistant_message",
    ],
  );
  const firstCall = document.timeline[1].blocks[0];
  const repeatedCall = document.timeline[3].blocks[0];
  assert.equal(firstCall.tool_call_id, "reused-write-id");
  assert.equal(repeatedCall.tool_call_id, "reused-write-id");
  assert.notEqual(firstCall.block_id, repeatedCall.block_id);
  document.timeline = document.timeline.slice(0, 4);
  const expectedRevision = crashed.state_revision;
  crashed.state_revision += 1;
  await store.save(crashed, expectedRevision);

  const reloaded = createCore(store, provider, []);
  await reloaded.handle(createCommand("bootstrap", {}));

  const recovered = (await store.load()).documents[0];
  assert.deepEqual(
    recovered.timeline.map((entry) => entry.type),
    [
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
      "tool_result",
    ],
  );
  const firstResult = recovered.timeline[2];
  const repeatedResult = recovered.timeline[4];
  assert.equal(firstResult.tool_call_block_id, firstCall.block_id);
  assert.equal(firstResult.is_error, false);
  assert.equal(firstResult.file_change?.path, "/same.txt");
  assert.equal(repeatedResult.tool_call_id, "reused-write-id");
  assert.equal(repeatedResult.tool_call_block_id, repeatedCall.block_id);
  assert.equal(repeatedResult.is_error, true);
  assert.equal(repeatedResult.file_change, undefined);
  assert.equal((await workspace.read("/same.txt")).content, "same content\n");
});

test("replace_text rejects overlapping matches without changing the file", async () => {
  const store = new MemoryProjectStore();
  const workspace = new MemoryFileSystem({ "/overlap.txt": "aaa" });
  const provider = new MemoryWorkspaceBackend(() => workspace);
  const events = [];
  let requestCount = 0;
  const core = createCore(store, provider, events, {
    async *stream(request) {
      requestCount += 1;
      if (requestCount === 1) {
        yield* toolCallEvents({
          tool_call_id: "ambiguous-replace",
          tool_name: "replace_text",
          arguments: {
            path: "/overlap.txt",
            old_text: "aa",
            new_text: "b",
          },
        });
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      const result = request.messages.at(-1);
      assert.equal(result.role, "tool");
      assert.equal(result.tool_call_id, "ambiguous-replace");
      assert.equal(result.is_error, true);
      assert.match(result.content, /more than once/);
      yield* textEvents("I need a unique match.");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Make an ambiguous replacement",
    }),
  );

  assert.equal((await workspace.read("/overlap.txt")).content, "aaa");
  assert.deepEqual((await workspace.listChanges()).changes, []);
  const toolResult = (await store.load()).documents[0].timeline.find(
    (entry) => entry.type === "tool_result",
  );
  assert.ok(toolResult);
  assert.equal(toolResult.is_error, true);
  const toolCall = (await store.load()).documents[0].timeline
    .filter((entry) => entry.type === "assistant_message")
    .flatMap((entry) => entry.blocks)
    .find((block) => block.type === "tool_call");
  assert.equal(toolResult.tool_call_block_id, toolCall.block_id);
  assert.equal(
    events.some((event) => event.type === "workspace_changed"),
    false,
  );
});

test("length stops surface as a terminal core error", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events, {
    async *stream() {
      yield* textEvents("Partial response");
      yield { type: "done", stop_reason: "length" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Write a long response",
    }),
  );

  const document = (await store.load()).documents[0];
  const assistant = document.timeline.at(-1);
  assert.equal(assistant.type, "assistant_message");
  assert.equal(assistant.blocks[0].type, "assistant_text");
  assert.equal(assistant.blocks[0].text, "Partial response");
  assert.equal(assistant.status, "complete");
  assert.equal(assistant.stop_reason, "length");
  const updated = events.findLast(
    (event) =>
      event.type === "timeline_entry_updated" &&
      event.payload.entry.entry_id === assistant.entry_id,
  );
  assert.equal(updated.payload.entry.stop_reason, "length");
  const error = events.findLast((event) => event.type === "error");
  assert.equal(error.payload.code, "agent_run_failed");
  assert.equal(
    error.payload.message,
    "The model stopped because it reached its output limit.",
  );
});

test("invalid tool transcripts terminate cleanly and do not brick the chat", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const requests = [];
  const core = createCore(store, provider, events, {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        yield* toolCallEvents({
          tool_call_id: "duplicate-call",
          tool_name: "read_file",
          arguments: { path: "/README.md" },
        }, 0);
        yield* toolCallEvents({
          tool_call_id: "duplicate-call",
          tool_name: "list_files",
          arguments: { path: "/" },
        }, 1);
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield* textEvents("Recovered");
      yield { type: "done", stop_reason: "stop" };
    },
  });

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Return an invalid tool turn",
    }),
  );

  const afterFailure = (await store.load()).documents[0];
  assert.deepEqual(
    afterFailure.timeline.map((entry) => entry.type),
    ["user_message", "assistant_message", "tool_result"],
  );
  const failedAssistant = afterFailure.timeline[1];
  assert.equal(failedAssistant.status, "error");
  assert.equal(failedAssistant.stop_reason, "error");
  const retainedCalls = failedAssistant.blocks.filter(
    (block) => block.type === "tool_call",
  );
  assert.equal(retainedCalls.length, 1);
  const failedResult = afterFailure.timeline[2];
  assert.equal(failedResult.tool_call_block_id, retainedCalls[0].block_id);
  assert.equal(failedResult.tool_call_id, retainedCalls[0].tool_call_id);
  assert.equal(failedResult.tool_name, retainedCalls[0].tool_name);
  assert.equal(failedResult.is_error, true);

  const failedState = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: failedState.active_project_id,
      session_id: failedState.active_session_id,
      text: "Continue after the provider error",
    }),
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, "user");
  assert.equal(
    requests[1].messages.at(-1).content,
    "Continue after the provider error",
  );
  assert.equal(
    (await store.load()).documents[0].timeline.at(-1).status,
    "complete",
  );
});

test("projects keep isolated filesystems without requiring a session", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const firstProjectId = initial.active_project_id;
  await (await provider.open(firstProjectId)).write("/only-a.txt", "A");

  await core.handle(createCommand("project_create", { name: "Project B" }));
  const second = latestState(events);
  const secondProjectId = second.active_project_id;
  assert.notEqual(secondProjectId, firstProjectId);
  assert.equal(second.active_session_id, null);
  assert.equal(second.sessions.length, 0);

  await core.handle(
    createCommand("fs_read", {
      project_id: secondProjectId,
      path: "/only-a.txt",
    }),
  );
  assert.equal(events.at(-1).payload.code, "fs_read_failed");
  await core.handle(
    createCommand("project_select", { project_id: firstProjectId }),
  );
  await core.handle(
    createCommand("fs_read", {
      project_id: firstProjectId,
      path: "/only-a.txt",
    }),
  );
  assert.equal(events.at(-1).payload.content, "A");

  await core.handle(
    createCommand("project_delete", { project_id: firstProjectId }),
  );
  await core.handle(
    createCommand("project_delete", { project_id: secondProjectId }),
  );
  const replacement = latestState(events);
  assert.equal(replacement.projects.length, 1);
  assert.equal(replacement.projects[0].name, "Local workspace");
  assert.equal(replacement.active_session_id, null);
  assert.equal(replacement.sessions.length, 0);
});

test("project deletion cleans an unused replacement after a mutation rebase", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const deletedProjectId = initial.active_project_id;
  const persistedInitial = await store.load();
  const concurrentProject = {
    ...structuredClone(persistedInitial.projects[0]),
    project_id: "concurrent-project",
    name: "Concurrent project",
    created_at: "2026-07-28T00:00:00.000Z",
    updated_at: "2026-07-28T00:00:00.000Z",
    last_session_id: null,
  };
  await provider.create(concurrentProject.project_id);

  const createWorkspace = provider.create.bind(provider);
  let replacementProjectId = null;
  provider.create = async (projectId, options) => {
    replacementProjectId = projectId;
    return createWorkspace(projectId, options);
  };
  const mutate = store.mutate.bind(store);
  let rebased = false;
  store.mutate = async (mutation) => {
    if (!rebased) {
      rebased = true;
      const stale = await store.load();
      mutation(stale);
      await mutate((draft) => {
        draft.projects.push(concurrentProject);
        return draft;
      });
    }
    return mutate(mutation);
  };

  await core.handle(
    createCommand("project_delete", {
      project_id: deletedProjectId,
    }),
  );

  assert.ok(replacementProjectId);
  assert.deepEqual(
    (await store.load()).projects.map((project) => project.project_id),
    [concurrentProject.project_id],
  );
  await assert.rejects(
    provider.open(replacementProjectId),
    (error) => error?.code === "not_found",
  );
  await provider.open(concurrentProject.project_id);
});

test("project selection remains local across cores sharing one store", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const seedEvents = [];
  const seedCore = createCore(store, provider, seedEvents);
  await seedCore.handle(createCommand("bootstrap", {}));
  const firstProjectId = latestState(seedEvents).active_project_id;
  await seedCore.handle(createCommand("project_create", { name: "Second" }));
  const secondProjectId = latestState(seedEvents).active_project_id;
  const persistedBeforeSelection = await store.load();

  const firstEvents = [];
  const secondEvents = [];
  const firstCore = createCore(store, provider, firstEvents);
  const secondCore = createCore(store, provider, secondEvents);
  await firstCore.handle(
    createCommand("bootstrap", {
      active_project_id: firstProjectId,
      active_session_id: null,
    }),
  );
  await secondCore.handle(
    createCommand("bootstrap", {
      active_project_id: secondProjectId,
      active_session_id: null,
    }),
  );

  assert.equal(latestState(firstEvents).active_project_id, firstProjectId);
  assert.equal(latestState(secondEvents).active_project_id, secondProjectId);
  await firstCore.handle(
    createCommand("project_select", { project_id: secondProjectId }),
  );
  assert.equal(latestState(firstEvents).active_project_id, secondProjectId);
  assert.equal(latestState(secondEvents).active_project_id, secondProjectId);
  await firstCore.handle(
    createCommand("project_select", { project_id: firstProjectId }),
  );
  assert.equal(latestState(firstEvents).active_project_id, firstProjectId);
  assert.equal(latestState(secondEvents).active_project_id, secondProjectId);
  assert.deepEqual(await store.load(), persistedBeforeSelection);
});

test("shared-store invalidation refreshes another core without moving its selection", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const seedEvents = [];
  const seedCore = createCore(store, provider, seedEvents);
  await seedCore.handle(createCommand("bootstrap", {}));
  const firstProjectId = latestState(seedEvents).active_project_id;
  await seedCore.handle(createCommand("project_create", { name: "Second" }));
  const secondProjectId = latestState(seedEvents).active_project_id;

  const firstEvents = [];
  const secondEvents = [];
  const firstCore = createCore(store, provider, firstEvents);
  const secondCore = createCore(store, provider, secondEvents);
  await firstCore.handle(
    createCommand("bootstrap", {
      active_project_id: firstProjectId,
      active_session_id: null,
    }),
  );
  await secondCore.handle(
    createCommand("bootstrap", {
      active_project_id: secondProjectId,
      active_session_id: null,
    }),
  );
  await secondCore.handle(
    createCommand("input_draft_update", {
      project_id: secondProjectId,
      session_id: null,
      input_draft: "Keep this tab-local composer context",
    }),
  );
  const revisionBeforeRename = latestState(secondEvents).state_revision;

  await firstCore.handle(
    createCommand("project_update", {
      project_id: firstProjectId,
      name: "Renamed elsewhere",
    }),
  );
  await waitForCondition(
    () => latestState(secondEvents).state_revision > revisionBeforeRename,
  );

  const refreshed = latestState(secondEvents);
  assert.equal(refreshed.active_project_id, secondProjectId);
  assert.equal(refreshed.active_session_id, null);
  assert.equal(refreshed.input_draft, "Keep this tab-local composer context");
  assert.equal(
    refreshed.projects.find(
      (project) => project.project_id === firstProjectId,
    ).name,
    "Renamed elsewhere",
  );
});

test("local commits skip redundant reloads while remote commits refresh once", async () => {
  const store = new MemoryProjectStore();
  const load = store.load.bind(store);
  let loadCalls = 0;
  store.load = async () => {
    loadCalls += 1;
    return load();
  };
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await flushTasks();
  const bootstrapLoadCalls = loadCalls;

  await core.handle(
    createCommand("input_draft_update", {
      project_id: initial.active_project_id,
      session_id: null,
      input_draft: "local draft",
    }),
  );
  await flushTasks();
  assert.equal(loadCalls, bootstrapLoadCalls);

  const revisionBeforeRemoteCommit = latestState(events).state_revision;
  await store.mutate((draft) => {
    draft.projects[0].name = "Remote name";
    return draft;
  });
  await waitForCondition(
    () => latestState(events).state_revision > revisionBeforeRemoteCommit,
  );
  assert.equal(loadCalls, bootstrapLoadCalls + 1);
  assert.equal(latestState(events).projects[0].name, "Remote name");
});

test("remote deletion releases cached workspaces for inactive projects", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const ownerEvents = [];
  const owner = createCore(store, provider, ownerEvents);
  await owner.handle(createCommand("bootstrap", {}));
  const retainedProjectId = latestState(ownerEvents).active_project_id;
  await owner.handle(createCommand("project_create", { name: "Temporary" }));
  const deletedProjectId = latestState(ownerEvents).active_project_id;

  const observerEvents = [];
  const observer = createCore(store, provider, observerEvents);
  await observer.handle(
    createCommand("bootstrap", {
      active_project_id: retainedProjectId,
      active_session_id: null,
    }),
  );
  await observer.handle(
    createCommand("project_select", { project_id: deletedProjectId }),
  );
  await observer.handle(
    createCommand("project_select", { project_id: retainedProjectId }),
  );
  assert.equal(observer.workspaces.has(deletedProjectId), true);
  const revisionBeforeDeletion = latestState(observerEvents).state_revision;

  await owner.handle(
    createCommand("project_delete", { project_id: deletedProjectId }),
  );
  await waitForCondition(
    () =>
      latestState(observerEvents).state_revision > revisionBeforeDeletion,
  );

  assert.equal(observer.workspaces.has(deletedProjectId), false);
  assert.equal(
    latestState(observerEvents).projects.some(
      (project) => project.project_id === deletedProjectId,
    ),
    false,
  );
});

test("workspace revert refreshes another core without another command", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const seedEvents = [];
  const seedCore = createCore(store, provider, seedEvents);
  await seedCore.handle(createCommand("bootstrap", {}));
  const projectId = latestState(seedEvents).active_project_id;
  const workspace = await provider.open(projectId);
  const write = await workspace.write(
    "/cross-tab-revert.txt",
    "temporary\n",
    {
      change: createWorkspaceChangeMetadata("cross-tab-revert"),
    },
  );
  const receipt = write.result.change;
  assert.ok(receipt);

  const firstEvents = [];
  const secondEvents = [];
  const firstCore = createCore(store, provider, firstEvents);
  const secondCore = createCore(store, provider, secondEvents);
  const selection = {
    active_project_id: projectId,
    active_session_id: null,
  };
  await firstCore.handle(createCommand("bootstrap", selection));
  await secondCore.handle(createCommand("bootstrap", selection));

  const before = latestState(secondEvents);
  assert.equal(before.workspace_revision, write.workspace_revision);
  assert.ok(
    before.files.some((file) => file.path === "/cross-tab-revert.txt"),
  );

  await firstCore.handle(
    createCommand("workspace_change_revert", {
      project_id: projectId,
      change_id: receipt.change_id,
    }),
  );
  await waitForCondition(
    () =>
      latestState(secondEvents).state_revision > before.state_revision &&
      latestState(secondEvents).workspace_revision >
        before.workspace_revision,
  );

  const refreshed = latestState(secondEvents);
  assert.equal(refreshed.active_project_id, projectId);
  assert.equal(refreshed.workspace_revision, write.workspace_revision + 1);
  assert.equal(
    refreshed.files.some(
      (file) => file.path === "/cross-tab-revert.txt",
    ),
    false,
  );
  const remoteSnapshot = secondEvents.at(-1);
  assert.equal(remoteSnapshot.type, "state_snapshot");
  assert.equal(remoteSnapshot.request_id, undefined);
});

test("a stale core reloads the canonical transcript before its next prompt", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const seedEvents = [];
  const seedCore = createCore(store, provider, seedEvents);
  await seedCore.handle(createCommand("bootstrap", {}));
  const initial = latestState(seedEvents);
  await seedCore.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Seed turn",
    }),
  );
  const sessionId = latestState(seedEvents).active_session_id;

  const firstEvents = [];
  const secondEvents = [];
  const firstCore = createCore(store, provider, firstEvents);
  let secondRequest;
  const secondCore = createCore(
    withoutChangeNotifications(store),
    provider,
    secondEvents,
    {
      async *stream(request) {
        secondRequest = structuredClone(request);
        yield* textEvents("Second tab reply");
        yield { type: "done" };
      },
    },
  );
  const selection = {
    active_project_id: initial.active_project_id,
    active_session_id: sessionId,
  };
  await firstCore.handle(createCommand("bootstrap", selection));
  await secondCore.handle(createCommand("bootstrap", selection));

  await firstCore.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: sessionId,
      text: "First tab turn",
    }),
  );
  await secondCore.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: sessionId,
      text: "Second tab turn",
    }),
  );

  assert.deepEqual(
    secondRequest.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    ["Seed turn", "First tab turn", "Second tab turn"],
  );
  assert.deepEqual(
    (await store.load()).documents[0].timeline
      .filter((entry) => entry.type === "user_message")
      .map((entry) => entry.content),
    ["Seed turn", "First tab turn", "Second tab turn"],
  );
});

test("imports a validated workspace as a revision-zero project", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));

  const command = createCommand("project_import", {
    name: " Imported workspace ",
    files: [
      { path: "/z.txt", content: "last" },
      { path: "/docs/é.txt", content: "first" },
      { path: "/empty.txt", content: "" },
    ],
  });
  await core.handle(command);

  const state = latestState(events);
  const importedProject = state.projects.find(
    (project) => project.name === "Imported workspace",
  );
  assert.ok(importedProject);
  assert.equal(state.projects.length, 2);
  assert.equal(state.active_project_id, importedProject.project_id);
  assert.equal(state.active_session_id, null);
  assert.equal(state.workspace_revision, 0);
  const workspace = await provider.open(state.active_project_id);
  assert.deepEqual(await workspace.listChanges(), {
    workspace_revision: 0,
    changes: [],
  });
  assert.equal((await workspace.read("/docs/é.txt")).content, "first");
  assert.equal((await workspace.read("/empty.txt")).content, "");
  assert.equal((await workspace.read("/z.txt")).content, "last");
  await assert.rejects(
    workspace.read("/README.md"),
    (error) => error?.code === "not_found",
  );
  assert.equal(events.at(-1).request_id, command.request_id);
});

test("acknowledges an import from its pre-commit workspace snapshot", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const create = provider.create.bind(provider);
  let importedListCalls = 0;
  provider.create = async (projectId, options) => {
    const workspace = await create(projectId, options);
    if (options?.initial_files === undefined) return workspace;
    return {
      ...workspace,
      async list(path) {
        importedListCalls += 1;
        if (importedListCalls > 1) {
          throw new Error("Post-commit listing must not be required.");
        }
        return workspace.list(path);
      },
    };
  };
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const command = createCommand("project_import", {
    name: "Cached import",
    files: [{ path: "/imported.txt", content: "durable" }],
  });

  await core.handle(command);

  assert.equal(importedListCalls, 1);
  assert.equal(events.at(-1).type, "state_snapshot");
  assert.equal(events.at(-1).request_id, command.request_id);
  assert.equal(
    latestState(events).projects.some(
      (project) => project.name === "Cached import",
    ),
    true,
  );
  assert.equal(
    (await store.load()).projects.some(
      (project) => project.name === "Cached import",
    ),
    true,
  );
});

test("rejects invalid workspace imports without creating a project", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const before = await store.load();

  await core.handle(
    createCommand("project_import", {
      name: "Invalid",
      files: [
        { path: "/file", content: "parent" },
        { path: "/file/child.txt", content: "child" },
      ],
    }),
  );

  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).payload.code, "invalid_workspace_import");
  assert.deepEqual(await store.load(), before);
});

test("applies configured workspace transfer limits to imports and exports", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events, undefined, {
    workspaceTransferOptions: {
      limits: {
        max_file_bytes: 4,
        max_total_content_bytes: 4,
      },
    },
  });
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;

  await core.handle(
    createCommand("project_import", {
      name: "Too large",
      files: [{ path: "/large.txt", content: "12345" }],
    }),
  );

  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).payload.code, "invalid_workspace_import");
  assert.equal((await store.load()).projects.length, 1);

  await core.handle(
    createCommand("workspace_export", {
      project_id: projectId,
    }),
  );

  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).payload.code, "workspace_export_failed");
  assert.match(events.at(-1).payload.message, /configured limit/);
});

test("rolls back an imported workspace when project persistence fails", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const before = await store.load();
  const create = provider.create.bind(provider);
  const remove = provider.delete.bind(provider);
  let importedProjectId = null;
  let rolledBackProjectId = null;
  provider.create = async (projectId, options) => {
    if (options?.initial_files !== undefined) {
      importedProjectId = projectId;
    }
    return create(projectId, options);
  };
  provider.delete = async (projectId) => {
    rolledBackProjectId = projectId;
    return remove(projectId);
  };
  const mutate = store.mutate.bind(store);
  store.mutate = (mutation) =>
    mutate((draft) => {
      const result = mutation(draft);
      if (result && result.projects.length > 1) {
        throw new Error("Disk full");
      }
      return result;
    });

  await assert.rejects(
    core.handle(
      createCommand("project_import", {
        name: "Must roll back",
        files: [{ path: "/imported.txt", content: "temporary" }],
      }),
    ),
    /Disk full/,
  );

  assert.ok(importedProjectId);
  assert.equal(rolledBackProjectId, importedProjectId);
  assert.deepEqual(await store.load(), before);
  await assert.rejects(
    provider.open(importedProjectId),
    (error) => error?.code === "not_found",
  );
});

test("preserves a workspace when a reported save failure already committed", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));

  const create = provider.create.bind(provider);
  const remove = provider.delete.bind(provider);
  let importedProjectId = null;
  let deletedProjectId = null;
  provider.create = async (projectId, options) => {
    if (options?.initial_files !== undefined) {
      importedProjectId = projectId;
    }
    return create(projectId, options);
  };
  provider.delete = async (projectId) => {
    deletedProjectId = projectId;
    return remove(projectId);
  };
  const mutate = store.mutate.bind(store);
  let loseCommitResponse = true;
  store.mutate = async (mutation) => {
    const commit = await mutate(mutation);
    if (loseCommitResponse && commit.state.projects.length > 1) {
      loseCommitResponse = false;
      throw new Error("Commit response was lost");
    }
    return commit;
  };

  await assert.rejects(
    core.handle(
      createCommand("project_import", {
        name: "Durably committed",
        files: [{ path: "/kept.txt", content: "keep me" }],
      }),
    ),
    /Commit response was lost/,
  );

  assert.ok(importedProjectId);
  assert.equal(deletedProjectId, null);
  assert.equal(
    (await store.load()).projects.some(
      (project) => project.project_id === importedProjectId,
    ),
    true,
  );
  assert.equal(
    (await (await provider.open(importedProjectId)).read("/kept.txt"))
      .content,
    "keep me",
  );
});

test("leaves project state unchanged when imported workspace creation fails", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const before = await store.load();
  const create = provider.create.bind(provider);
  provider.create = async (projectId, options) => {
    if (options?.initial_files !== undefined) {
      throw new Error("Workspace storage unavailable");
    }
    return create(projectId, options);
  };
  events.length = 0;
  const command = createCommand("project_import", {
    name: "Cannot create",
    files: [{ path: "/imported.txt", content: "never stored" }],
  });

  await assert.rejects(
    core.handle(command),
    /Workspace storage unavailable/,
  );

  assert.deepEqual(await store.load(), before);
  assert.deepEqual(events, []);
});

test("exports active and inactive project snapshots without changing selection", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const firstProjectId = latestState(events).active_project_id;
  await (await provider.open(firstProjectId)).write(
    "/only-first.txt",
    "first",
  );
  await core.handle(createCommand("project_create", { name: "Second" }));
  const secondProjectId = latestState(events).active_project_id;
  await (await provider.open(secondProjectId)).write(
    "/only-second.txt",
    "second",
  );

  const inactiveExport = createCommand("workspace_export", {
    project_id: firstProjectId,
  });
  await core.handle(inactiveExport);
  assert.deepEqual(events.at(-1), {
    protocol_version: events.at(-1).protocol_version,
    event_id: events.at(-1).event_id,
    request_id: inactiveExport.request_id,
    type: "workspace_export_snapshot",
    payload: {
      project_id: firstProjectId,
      project_name: "Local workspace",
      workspace_revision: 1,
      files: [
        { path: "/README.md", content: "# Test" },
        { path: "/only-first.txt", content: "first" },
      ],
    },
  });
  assert.equal((await store.load()).active_project_id, secondProjectId);

  const activeExport = createCommand("workspace_export", {
    project_id: secondProjectId,
  });
  await core.handle(activeExport);
  assert.equal(events.at(-1).type, "workspace_export_snapshot");
  assert.equal(events.at(-1).request_id, activeExport.request_id);
  assert.deepEqual(events.at(-1).payload, {
    project_id: secondProjectId,
    project_name: "Second",
    workspace_revision: 1,
    files: [
      { path: "/README.md", content: "# Test" },
      { path: "/only-second.txt", content: "second" },
    ],
  });
  assert.equal((await store.load()).active_project_id, secondProjectId);
});

test("cancels one active export and coalesces duplicate request ids", async () => {
  const store = new MemoryProjectStore();
  let blockCapture = true;
  let captureCount = 0;
  let captureSignal;
  let markCaptureStarted;
  const captureStarted = new Promise((resolve) => {
    markCaptureStarted = resolve;
  });
  const provider = new MemoryWorkspaceBackend((initialFiles) => {
    const workspace = new MemoryFileSystem(
      Object.fromEntries(
        (initialFiles ?? [{ path: "/README.md", content: "# Test" }]).map(
          ({ path, content }) => [path, content],
        ),
      ),
    );
    const readFilesSnapshot = workspace.readFilesSnapshot.bind(workspace);
    workspace.readFilesSnapshot = async (options) => {
      captureCount += 1;
      if (!blockCapture) return readFilesSnapshot(options);
      captureSignal = options?.signal;
      markCaptureStarted();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(captureSignal.reason);
        if (captureSignal.aborted) {
          abort();
        } else {
          captureSignal.addEventListener("abort", abort, { once: true });
        }
      });
    };
    return workspace;
  });
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const exportCommand = createCommand("workspace_export", {
    project_id: projectId,
  });
  const exportHandling = core.handle(exportCommand);
  await captureStarted;
  const duplicateHandling = core.handle({
    ...exportCommand,
    payload: { ...exportCommand.payload },
  });
  await duplicateHandling;
  assert.equal(captureCount, 1);

  await core.handle(
    createCommand("workspace_export_cancel", {
      target_request_id: "another-export",
    }),
  );
  assert.equal(captureSignal.aborted, false);

  await core.handle(
    createCommand("workspace_export_cancel", {
      target_request_id: exportCommand.request_id,
    }),
  );
  await exportHandling;

  assert.equal(captureSignal.aborted, true);
  assert.equal(
    events.some(
      (event) =>
        event.type === "workspace_export_snapshot" &&
        event.request_id === exportCommand.request_id,
    ),
    false,
  );
  const canceled = events.find(
    (event) =>
      event.type === "error" &&
      event.request_id === exportCommand.request_id,
  );
  assert.equal(canceled.payload.code, "workspace_export_cancelled");

  const reusedRequestId = "future-export";
  await core.handle(
    createCommand("workspace_export_cancel", {
      target_request_id: reusedRequestId,
    }),
  );
  blockCapture = false;
  await core.handle({
    ...createCommand("workspace_export", { project_id: projectId }),
    request_id: reusedRequestId,
  });
  assert.equal(events.at(-1).type, "workspace_export_snapshot");
  assert.equal(events.at(-1).request_id, reusedRequestId);
});

test("an export canceled while queued never starts workspace capture", async () => {
  const store = new MemoryProjectStore();
  let captureCount = 0;
  let markFirstCaptureStarted;
  const firstCaptureStarted = new Promise((resolve) => {
    markFirstCaptureStarted = resolve;
  });
  const provider = new MemoryWorkspaceBackend((initialFiles) => {
    const workspace = new MemoryFileSystem(
      Object.fromEntries(
        (initialFiles ?? [{ path: "/README.md", content: "# Test" }]).map(
          ({ path, content }) => [path, content],
        ),
      ),
    );
    workspace.readFilesSnapshot = async (options) => {
      captureCount += 1;
      if (captureCount === 1) markFirstCaptureStarted();
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        const abort = () => reject(signal.reason);
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      });
    };
    return workspace;
  });
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const projectId = latestState(events).active_project_id;
  const firstExport = createCommand("workspace_export", {
    project_id: projectId,
  });
  const queuedExport = createCommand("workspace_export", {
    project_id: projectId,
  });
  const firstHandling = core.handle(firstExport);
  await firstCaptureStarted;
  const queuedHandling = core.handle(queuedExport);
  await Promise.resolve();

  await core.handle(
    createCommand("workspace_export_cancel", {
      target_request_id: queuedExport.request_id,
    }),
  );
  await core.handle(
    createCommand("workspace_export_cancel", {
      target_request_id: firstExport.request_id,
    }),
  );
  await Promise.all([firstHandling, queuedHandling]);

  assert.equal(captureCount, 1);
  for (const command of [firstExport, queuedExport]) {
    assert.equal(
      events.some(
        (event) =>
          event.type === "error" &&
          event.request_id === command.request_id &&
          event.payload.code === "workspace_export_cancelled",
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "workspace_export_snapshot" &&
          event.request_id === command.request_id,
      ),
      false,
    );
  }
});

test("rejects workspace import and export while a model run is active", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const core = createCore(store, provider, events, {
    async *stream(_request, signal) {
      markStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
      yield { type: "done" };
    },
  });
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const prompt = core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Keep running",
    }),
  );
  await started;
  const active = latestState(events);

  await core.handle(
    createCommand("workspace_export", {
      project_id: active.active_project_id,
    }),
  );
  assert.equal(events.at(-1).payload.code, "run_in_progress");
  await core.handle(
    createCommand("project_import", {
      name: "Blocked import",
      files: [{ path: "/blocked.txt", content: "blocked" }],
    }),
  );
  assert.equal(events.at(-1).payload.code, "run_in_progress");
  assert.equal((await store.load()).projects.length, 1);
  assert.equal(
    events.some((event) => event.type === "workspace_export_snapshot"),
    false,
  );

  await core.handle(
    createCommand("abort", {
      project_id: active.active_project_id,
      session_id: active.active_session_id,
    }),
  );
  await prompt;
});

test("a failed first-session commit never starts transport or creates a session", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let transportStarted = false;
  const core = createCore(store, provider, events, {
    async *stream() {
      transportStarted = true;
      yield { type: "done" };
    },
  });
  await core.handle(createCommand("bootstrap", {}));
  const state = latestState(events);
  const mutate = store.mutate.bind(store);
  store.mutate = (mutation) =>
    mutate((draft) => {
      const result = mutation(draft);
      if (result && result.sessions.length > 0) {
        throw new Error("Disk full");
      }
      return result;
    });

  await core.handle(
    createCommand("prompt", {
      project_id: state.active_project_id,
      session_id: null,
      text: "Must be atomic",
    }),
  );
  assert.equal(transportStarted, false);
  assert.equal((await store.load()).sessions.length, 0);
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).payload.code, "persistence_failed");
});

test("reload repairs an incomplete persisted tool transcript by block identity", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Create a transcript",
    }),
  );

  const interrupted = await store.load();
  const sessionId = interrupted.active_session_id;
  const document = interrupted.documents.find(
    (candidate) => candidate.session_id === sessionId,
  );
  const assistant = document.timeline.at(-1);
  assert.equal(assistant.type, "assistant_message");
  assistant.stop_reason = "tool_use";
  assistant.blocks = [
    {
      type: "tool_call",
      block_id: "interrupted-tool-block",
      tool_call_id: "interrupted-provider-id",
      tool_name: "read_file",
      arguments: { path: "/README.md" },
    },
  ];
  const expectedRevision = interrupted.state_revision;
  interrupted.state_revision += 1;
  await store.save(interrupted, expectedRevision);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));
  const repaired = (await store.load()).documents[0].timeline.at(-1);
  assert.equal(repaired.type, "tool_result");
  assert.equal(repaired.tool_call_block_id, "interrupted-tool-block");
  assert.equal(repaired.tool_call_id, "interrupted-provider-id");
  assert.equal(repaired.is_error, true);
  assert.equal(repaired.summary, "Result unavailable after reload");
  assert.match(repaired.content, /operation may have completed/i);
  assert.equal(latestState(reloadedEvents).active_session_id, sessionId);
});

test("startup repair retains a concurrent change after a save conflict", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: initial.active_project_id,
      session_id: null,
      text: "Create an interrupted response",
    }),
  );

  const interrupted = await store.load();
  const assistant = interrupted.documents[0].timeline.at(-1);
  assert.equal(assistant.type, "assistant_message");
  assistant.status = "streaming";
  delete assistant.stop_reason;
  const expectedRevision = interrupted.state_revision;
  interrupted.state_revision += 1;
  await store.save(interrupted, expectedRevision);
  await core.dispose();

  const save = store.save.bind(store);
  let repairSaveAttempts = 0;
  store.save = async (state, expected_revision) => {
    repairSaveAttempts += 1;
    if (repairSaveAttempts === 1) {
      await store.mutate((draft) => {
        draft.projects[0].name = "Renamed concurrently";
        return draft;
      });
    }
    await save(state, expected_revision);
  };

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));

  assert.equal(repairSaveAttempts, 2);
  const repaired = await store.load();
  assert.equal(repaired.projects[0].name, "Renamed concurrently");
  const repairedAssistant = repaired.documents[0].timeline.at(-1);
  assert.equal(repairedAssistant.type, "assistant_message");
  assert.equal(repairedAssistant.status, "aborted");
  assert.equal(repairedAssistant.stop_reason, "aborted");
  assert.equal(
    latestState(reloadedEvents).projects[0].name,
    "Renamed concurrently",
  );
});

function createCore(
  store,
  provider,
  events,
  modelTransport,
  coreOptions = {},
) {
  return new ResearchBoxCore({
    projectStore: store,
    workspaceBackend: provider,
    modelTransport: modelTransport ?? {
      async *stream(request) {
        yield* textEvents(`Echo: ${promptFromRequest(request)}`);
        yield { type: "done" };
      },
    },
    model,
    systemPrompt: "You are a test agent.",
    eventSink: (event) => events.push(event),
    ...coreOptions,
  });
}

function withoutChangeNotifications(store) {
  return {
    load: () => store.load(),
    save: (state, expectedRevision) =>
      store.save(state, expectedRevision),
    mutate: (mutation) => store.mutate(mutation),
    saveInputDraft: (update) => store.saveInputDraft(update),
    subscribe: () => () => undefined,
  };
}

async function waitForCondition(condition) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for asynchronous core state.");
}

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function promptFromRequest(request) {
  assert.equal(request.provider_id, model.provider);
  assert.equal(request.model_id, model.id);
  assert.equal(request.system_prompt, "You are a test agent.");
  assert.deepEqual(
    request.tools.map((tool) => tool.name),
    [
      "list_files",
      "search_files",
      "read_file",
      "write_file",
      "replace_text",
      "remove_file",
    ],
  );
  const message = [...request.messages]
    .reverse()
    .find((candidate) => candidate.role === "user");
  assert.ok(message, "Expected the model request to contain a user message");
  return message.content;
}

function* textEvents(text, contentIndex = 0) {
  yield { type: "text_start", content_index: contentIndex };
  yield {
    type: "text_delta",
    content_index: contentIndex,
    text_delta: text,
  };
  yield { type: "text_end", content_index: contentIndex };
}

function* reasoningEvents(text, contentIndex = 0) {
  yield { type: "reasoning_start", content_index: contentIndex };
  yield {
    type: "reasoning_delta",
    content_index: contentIndex,
    reasoning_delta: text,
  };
  yield { type: "reasoning_end", content_index: contentIndex };
}

function* toolCallEvents(toolCall, contentIndex = 0) {
  yield { type: "tool_call_start", content_index: contentIndex };
  yield {
    type: "tool_call_delta",
    content_index: contentIndex,
    tool_call_id_delta: toolCall.tool_call_id,
    tool_name_delta: toolCall.tool_name,
    arguments_delta: JSON.stringify(toolCall.arguments),
  };
  yield {
    type: "tool_call_end",
    content_index: contentIndex,
    tool_call: structuredClone(toolCall),
  };
}

function describeTimeline(timeline) {
  return timeline.map((entry) => {
    if (entry.type === "user_message") {
      return { type: entry.type, content: entry.content };
    }
    if (entry.type === "tool_result") {
      return {
        type: entry.type,
        tool_call_id: entry.tool_call_id,
        tool_name: entry.tool_name,
        is_error: entry.is_error,
      };
    }
    return {
      type: entry.type,
      status: entry.status,
      blocks: entry.blocks.map((block) => {
        if (block.type === "tool_call") {
          return {
            type: block.type,
            tool_call_id: block.tool_call_id,
            tool_name: block.tool_name,
          };
        }
        return { type: block.type, text: block.text };
      }),
    };
  });
}

function createWorkspaceProvider() {
  const defaultFiles = [{ path: "/README.md", content: "# Test" }];
  return new MemoryWorkspaceBackend(
    (initialFiles) =>
      new MemoryFileSystem(
        Object.fromEntries(
          (initialFiles ?? defaultFiles).map(({ path, content }) => [
            path,
            content,
          ]),
        ),
      ),
  );
}

function createWorkspaceChangeMetadata(
  changeId,
  toolName = "write_file",
) {
  return {
    change_id: changeId,
    session_id: "receipt-session",
    tool_call_block_id: `block-${changeId}`,
    assistant_message_index: 0,
    tool_call_id: `tool-${changeId}`,
    tool_name: toolName,
    created_at: "2026-07-24T00:00:00.000Z",
  };
}

function latestState(events) {
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === "ready" || candidate.type === "state_snapshot",
    );
  assert.ok(event, "Expected an authoritative state event");
  return event.payload.state;
}
