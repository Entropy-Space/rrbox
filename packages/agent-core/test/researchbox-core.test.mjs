import assert from "node:assert/strict";
import test from "node:test";
import { MemoryProjectStore } from "@researchbox/project-store";
import { createCommand } from "@researchbox/protocol";
import {
  MemoryFileSystem,
  MemoryProjectFileSystemProvider,
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
      assert.equal(persisted.documents[0].messages.length, 2);
      assert.equal(persisted.documents[0].messages[0].content, prompt);
      assert.equal(persisted.documents[0].messages[1].status, "streaming");
      assert.equal(persisted.documents[0].agent_messages.at(-1).role, "user");
      yield { type: "text_delta", text_delta: `Echo: ${prompt}` };
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
      assert.equal(persisted.documents[0].messages.length, 2);
      assert.equal(persisted.documents[0].messages[0].content, prompt);
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
  assert.equal(persisted.documents[0].messages[0].content, "Plan the persistence layer");
  assert.equal(persisted.documents[0].messages[1].status, "complete");
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
      workspaceProvider: provider,
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
  await reloaded.handle(createCommand("bootstrap", {}));
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
    workspaceProvider: provider,
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
      workspaceProvider: provider,
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
  const provider = new MemoryProjectFileSystemProvider(() => workspace);
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
    workspaceProvider: provider,
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
  assert.equal(document.messages.at(-1).status, "aborted");
  assert.equal(document.agent_messages.at(-1).role, "assistant");
  assert.equal(document.agent_messages.at(-1).stop_reason, "aborted");
});

test("abort repairs unexecuted sequential tool calls before the next prompt", async () => {
  const store = new MemoryProjectStore();
  const workspace = new MemoryFileSystem({ "/README.md": "# Test" });
  const provider = new MemoryProjectFileSystemProvider(() => workspace);
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
        yield {
          type: "tool_call",
          tool_call_id: "read-call",
          tool_name: "read_file",
          arguments: { path: "/README.md" },
        };
        yield {
          type: "tool_call",
          tool_call_id: "list-call",
          tool_name: "list_files",
          arguments: { path: "/" },
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text_delta: "Recovered" };
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
  assert.equal(afterAbort.messages.at(-1).status, "aborted");
  const skippedResult = afterAbort.agent_messages.find(
    (message) =>
      message.role === "tool_result" && message.tool_call_id === "list-call",
  );
  assert.ok(skippedResult, "Expected a result for the unexecuted tool call");
  assert.equal(skippedResult.tool_name, "list_files");
  assert.equal(skippedResult.is_error, true);
  assert.equal(
    skippedResult.content[0].text,
    "Tool execution was skipped because the run was aborted.",
  );

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
    priorAssistant.tool_calls.map((toolCall) => toolCall.tool_call_id),
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
    (await store.load()).documents[0].messages.at(-1).status,
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
        yield {
          type: "tool_call",
          tool_call_id: "write-note",
          tool_name: "write_file",
          arguments: {
            path: "/notes/agent-note.md",
            content: initialContent,
          },
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      if (requests.length === 2) {
        const writeResult = request.messages.at(-1);
        assert.equal(writeResult.role, "tool");
        assert.equal(writeResult.tool_call_id, "write-note");
        assert.equal(writeResult.tool_name, "write_file");
        assert.equal(writeResult.is_error, false);
        yield {
          type: "tool_call",
          tool_call_id: "revise-note",
          tool_name: "replace_text",
          arguments: {
            path: "/notes/agent-note.md",
            old_text: "first draft",
            new_text: "ready to review",
          },
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      const replaceResult = request.messages.at(-1);
      assert.equal(replaceResult.role, "tool");
      assert.equal(replaceResult.tool_call_id, "revise-note");
      assert.equal(replaceResult.tool_name, "replace_text");
      assert.equal(replaceResult.is_error, false);
      yield { type: "text_delta", text_delta: "The note is ready." };
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
      text: "Create and revise a note",
    }),
  );

  const workspace = await provider.open(initial.active_project_id);
  assert.equal(await workspace.read("/notes/agent-note.md"), finalContent);
  const changes = await workspace.listChanges();
  assert.equal(changes.length, 2);
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
    ],
  );

  const persisted = await store.load();
  assert.deepEqual(
    persisted.documents[0].activities.map((activity) => ({
      tool_call_id: activity.tool_call_id,
      status: activity.status,
      path: activity.file_change?.path,
      summary: activity.summary,
    })),
    [
      {
        tool_call_id: "write-note",
        status: "complete",
        path: "/notes/agent-note.md",
        summary: "Created · +3 −0",
      },
      {
        tool_call_id: "revise-note",
        status: "complete",
        path: "/notes/agent-note.md",
        summary: "Updated · +1 −1",
      },
    ],
  );
  assert.equal(
    persisted.documents[0].agent_messages.filter(
      (message) => message.role === "tool_result" && !message.is_error,
    ).length,
    2,
  );
  assert.equal(latestState(events).workspace_revision, 2);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));
  assert.equal(
    latestState(reloadedEvents).activities.every(
      (activity) => activity.status === "complete",
    ),
    true,
  );
  assert.equal(await workspace.read("/notes/agent-note.md"), finalContent);
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
        yield {
          type: "tool_call",
          tool_call_id: "recover-write",
          tool_name: "write_file",
          arguments: {
            path: "/recovered.txt",
            content: "committed before reload\n",
          },
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text_delta: "Saved." };
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
    document.agent_messages.map((message) => message.role),
    ["user", "assistant", "tool_result", "assistant"],
  );
  document.agent_messages = document.agent_messages.slice(0, 2);
  document.messages.at(-1).content = "";
  document.messages.at(-1).status = "streaming";
  document.activities[0].status = "running";
  delete document.activities[0].summary;
  delete document.activities[0].file_change;
  const expectedRevision = crashed.state_revision;
  crashed.state_revision += 1;
  await store.save(crashed, expectedRevision);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));

  const recovered = (await store.load()).documents[0];
  assert.equal(recovered.messages.at(-1).status, "aborted");
  assert.deepEqual(
    recovered.agent_messages.map((message) => message.role),
    ["user", "assistant", "tool_result"],
  );
  assert.equal(recovered.agent_messages.at(-1).tool_call_id, "recover-write");
  assert.equal(recovered.agent_messages.at(-1).is_error, false);
  assert.deepEqual(
    {
      status: recovered.activities[0].status,
      summary: recovered.activities[0].summary,
      path: recovered.activities[0].file_change?.path,
      change_kind: recovered.activities[0].file_change?.change_kind,
    },
    {
      status: "complete",
      summary: "Created · +1 −0",
      path: "/recovered.txt",
      change_kind: "created",
    },
  );
  assert.equal(
    await (await provider.open(initial.active_project_id)).read("/recovered.txt"),
    "committed before reload\n",
  );
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
        yield {
          type: "tool_call",
          tool_call_id: "first-write",
          tool_name: "write_file",
          arguments: {
            path: "/first.txt",
            content: "first\n",
          },
        };
        yield {
          type: "tool_call",
          tool_call_id: "second-write",
          tool_name: "write_file",
          arguments: {
            path: "/second.txt",
            content: "second\n",
          },
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text_delta: "Both files are saved." };
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
  assert.equal(document.activities.length, 2);
  assert.deepEqual(
    document.activities.map((activity) => activity.tool_call_id),
    ["first-write", "second-write"],
  );
  assert.notEqual(
    document.activities[0].activity_id,
    document.activities[1].activity_id,
  );
  assert.equal(
    document.activities[0].message_id,
    document.activities[1].message_id,
  );
  assert.deepEqual(
    document.agent_messages.map((message) => message.role),
    ["user", "assistant", "tool_result", "tool_result", "assistant"],
  );
  document.agent_messages = document.agent_messages.slice(0, 3);
  document.messages.at(-1).content = "";
  document.messages.at(-1).status = "streaming";
  const secondActivity = document.activities.find(
    (activity) => activity.tool_call_id === "second-write",
  );
  assert.ok(secondActivity);
  secondActivity.status = "running";
  delete secondActivity.summary;
  delete secondActivity.file_change;
  const expectedRevision = crashed.state_revision;
  crashed.state_revision += 1;
  await store.save(crashed, expectedRevision);

  const reloaded = createCore(store, provider, []);
  await reloaded.handle(createCommand("bootstrap", {}));

  const recovered = (await store.load()).documents[0];
  assert.deepEqual(
    recovered.agent_messages.map((message) => message.role),
    ["user", "assistant", "tool_result", "tool_result"],
  );
  assert.deepEqual(
    {
      tool_call_id: recovered.agent_messages.at(-1).tool_call_id,
      is_error: recovered.agent_messages.at(-1).is_error,
      status: recovered.activities.find(
        (activity) => activity.tool_call_id === "second-write",
      )?.status,
      path: recovered.activities.find(
        (activity) => activity.tool_call_id === "second-write",
      )?.file_change?.path,
    },
    {
      tool_call_id: "second-write",
      is_error: false,
      status: "complete",
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
        yield {
          type: "tool_call",
          tool_call_id: "reused-write-id",
          tool_name: "write_file",
          arguments: {
            path: "/same.txt",
            content: "same content\n",
          },
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text_delta: "No further changes." };
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
  const changes = await workspace.listChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].assistant_message_index, 1);

  const crashed = await store.load();
  const document = crashed.documents[0];
  assert.equal(document.activities.length, 2);
  assert.deepEqual(
    document.activities.map((activity) => activity.tool_call_id),
    ["reused-write-id", "reused-write-id"],
  );
  assert.notEqual(
    document.activities[0].activity_id,
    document.activities[1].activity_id,
  );
  assert.equal(
    document.activities[0].message_id,
    document.activities[1].message_id,
  );
  assert.deepEqual(
    document.agent_messages.map((message) => message.role),
    [
      "user",
      "assistant",
      "tool_result",
      "assistant",
      "tool_result",
      "assistant",
    ],
  );
  document.agent_messages = document.agent_messages.slice(0, 4);
  document.messages.at(-1).content = "";
  document.messages.at(-1).status = "streaming";
  const repeatedActivity = document.activities.at(-1);
  repeatedActivity.status = "running";
  delete repeatedActivity.summary;
  delete repeatedActivity.file_change;
  const expectedRevision = crashed.state_revision;
  crashed.state_revision += 1;
  await store.save(crashed, expectedRevision);

  const reloaded = createCore(store, provider, []);
  await reloaded.handle(createCommand("bootstrap", {}));

  const recovered = (await store.load()).documents[0];
  assert.deepEqual(
    recovered.agent_messages.map((message) => message.role),
    ["user", "assistant", "tool_result", "assistant", "tool_result"],
  );
  assert.equal(recovered.agent_messages.at(-1).tool_call_id, "reused-write-id");
  assert.equal(recovered.agent_messages.at(-1).is_error, true);
  assert.equal(recovered.activities.length, 2);
  assert.equal(recovered.activities[0].status, "complete");
  assert.equal(recovered.activities[0].file_change?.path, "/same.txt");
  assert.equal(recovered.activities[1].status, "error");
  assert.equal(recovered.activities[1].file_change, undefined);
  assert.equal(await workspace.read("/same.txt"), "same content\n");
});

test("replace_text rejects overlapping matches without changing the file", async () => {
  const store = new MemoryProjectStore();
  const workspace = new MemoryFileSystem({ "/overlap.txt": "aaa" });
  const provider = new MemoryProjectFileSystemProvider(() => workspace);
  const events = [];
  let requestCount = 0;
  const core = createCore(store, provider, events, {
    async *stream(request) {
      requestCount += 1;
      if (requestCount === 1) {
        yield {
          type: "tool_call",
          tool_call_id: "ambiguous-replace",
          tool_name: "replace_text",
          arguments: {
            path: "/overlap.txt",
            old_text: "aa",
            new_text: "b",
          },
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      const result = request.messages.at(-1);
      assert.equal(result.role, "tool");
      assert.equal(result.tool_call_id, "ambiguous-replace");
      assert.equal(result.is_error, true);
      assert.match(result.content, /more than once/);
      yield { type: "text_delta", text_delta: "I need a unique match." };
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

  assert.equal(await workspace.read("/overlap.txt"), "aaa");
  assert.deepEqual(await workspace.listChanges(), []);
  assert.equal(
    (await store.load()).documents[0].activities[0].status,
    "error",
  );
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
      yield { type: "text_delta", text_delta: "Partial response" };
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
  assert.equal(document.messages.at(-1).content, "Partial response");
  assert.equal(document.messages.at(-1).status, "error");
  assert.equal(document.agent_messages.at(-1).stop_reason, "length");
  const messageFinished = events.findLast(
    (event) => event.type === "message_finished",
  );
  assert.equal(messageFinished.payload.status, "error");
  assert.equal(
    messageFinished.payload.error_message,
    "The model stopped because it reached its output limit.",
  );
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
        yield {
          type: "tool_call",
          tool_call_id: "duplicate-call",
          tool_name: "read_file",
          arguments: { path: "/README.md" },
        };
        yield {
          type: "tool_call",
          tool_call_id: "duplicate-call",
          tool_name: "list_files",
          arguments: { path: "/" },
        };
        yield { type: "done", stop_reason: "tool_use" };
        return;
      }
      yield { type: "text_delta", text_delta: "Recovered" };
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
  assert.equal(afterFailure.messages.at(-1).status, "error");
  assert.deepEqual(
    afterFailure.agent_messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(afterFailure.agent_messages.at(-1).stop_reason, "error");

  const failedState = latestState(events);
  await core.handle(
    createCommand("prompt", {
      project_id: failedState.active_project_id,
      session_id: failedState.active_session_id,
      text: "Continue after the provider error",
    }),
  );

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1].messages.map((message) => message.role),
    ["user", "user"],
  );
  assert.equal(
    (await store.load()).documents[0].messages.at(-1).status,
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
  const save = store.save.bind(store);
  store.save = async (next, expectedRevision) => {
    if (next.sessions.length > 0) throw new Error("Disk full");
    await save(next, expectedRevision);
  };

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

test("reload quarantines malformed persisted Pi transcripts", async () => {
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

  const corrupted = await store.load();
  const sessionId = corrupted.active_session_id;
  corrupted.documents.find(
    (document) => document.session_id === sessionId,
  ).agent_messages = [{ role: "custom", content: [] }];
  const expectedRevision = corrupted.state_revision;
  corrupted.state_revision += 1;
  await store.save(corrupted, expectedRevision);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));
  assert.deepEqual((await store.load()).documents[0].agent_messages, []);
  assert.equal(latestState(reloadedEvents).active_session_id, sessionId);
});

function createCore(store, provider, events, modelTransport) {
  return new ResearchBoxCore({
    projectStore: store,
    workspaceProvider: provider,
    modelTransport: modelTransport ?? {
      async *stream(request) {
        yield {
          type: "text_delta",
          text_delta: `Echo: ${promptFromRequest(request)}`,
        };
        yield { type: "done" };
      },
    },
    model,
    systemPrompt: "You are a test agent.",
    eventSink: (event) => events.push(event),
  });
}

function promptFromRequest(request) {
  assert.equal(request.provider_id, model.provider);
  assert.equal(request.model_id, model.id);
  assert.equal(request.system_prompt, "You are a test agent.");
  assert.deepEqual(
    request.tools.map((tool) => tool.name),
    ["list_files", "read_file", "write_file", "replace_text"],
  );
  const message = [...request.messages]
    .reverse()
    .find((candidate) => candidate.role === "user");
  assert.ok(message, "Expected the model request to contain a user message");
  return message.content;
}

function createWorkspaceProvider() {
  return new MemoryProjectFileSystemProvider(
    () => new MemoryFileSystem({ "/README.md": "# Test" }),
  );
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
