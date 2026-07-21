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

test("keeps new chat virtual and persists the first prompt before transport", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let transportStarted = false;
  const core = createCore(store, provider, events, {
    async *stream(request) {
      transportStarted = true;
      const persisted = await store.load();
      assert.equal(persisted.sessions.length, 1);
      assert.equal(persisted.active_session_id, persisted.sessions[0].session_id);
      assert.equal(persisted.projects[0].new_chat_draft, "");
      assert.equal(persisted.documents[0].input_draft, "");
      assert.equal(persisted.documents[0].messages.length, 2);
      assert.equal(persisted.documents[0].messages[0].content, request.prompt);
      assert.equal(persisted.documents[0].messages[1].status, "streaming");
      assert.equal(persisted.documents[0].agent_messages.at(-1).role, "user");
      yield { type: "text_delta", text_delta: `Echo: ${request.prompt}` };
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
      assert.equal(persisted.sessions.length, 1);
      assert.equal(persisted.documents[0].messages.length, 2);
      assert.equal(persisted.documents[0].messages[0].content, request.prompt);
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
        yield { type: "text_delta", text_delta: `Echo: ${request.prompt}` };
        yield { type: "done" };
      },
    },
    model,
    systemPrompt: "You are a test agent.",
    eventSink: (event) => events.push(event),
  });
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
