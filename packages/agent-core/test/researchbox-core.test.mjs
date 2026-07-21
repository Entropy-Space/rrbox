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

test("creates, restores, renames, switches, and deletes sessions", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);

  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const projectId = initial.active_project_id;
  const firstSessionId = initial.active_session_id;

  await core.handle(
    createCommand("prompt", {
      project_id: projectId,
      session_id: firstSessionId,
      text: "Plan the persistence layer",
    }),
  );
  const storedAfterPrompt = await store.load();
  const firstSession = storedAfterPrompt.sessions.find(
    (session) => session.session_id === firstSessionId,
  );
  assert.equal(firstSession.title, "Plan the persistence layer");
  assert.equal(
    storedAfterPrompt.documents.find(
      (document) => document.session_id === firstSessionId,
    ).messages.length,
    2,
  );

  await core.handle(createCommand("session_create", { project_id: projectId }));
  const created = latestState(events);
  const secondSessionId = created.active_session_id;
  assert.notEqual(secondSessionId, firstSessionId);
  assert.equal(created.sessions.length, 2);
  assert.deepEqual(created.messages, []);

  await core.handle(
    createCommand("session_update", {
      project_id: projectId,
      session_id: secondSessionId,
      title: "Implementation notes",
    }),
  );
  assert.equal(
    latestState(events).sessions.find(
      (session) => session.session_id === secondSessionId,
    ).title,
    "Implementation notes",
  );

  await core.handle(
    createCommand("session_select", {
      project_id: projectId,
      session_id: firstSessionId,
    }),
  );
  assert.equal(latestState(events).messages[0].content, "Plan the persistence layer");

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));
  assert.equal(latestState(reloadedEvents).active_session_id, firstSessionId);
  assert.equal(latestState(reloadedEvents).messages.length, 2);
  await reloaded.handle(
    createCommand("prompt", {
      project_id: projectId,
      session_id: firstSessionId,
      text: "Continue after reload",
    }),
  );
  const continuedDocument = (await store.load()).documents.find(
    (document) => document.session_id === firstSessionId,
  );
  assert.equal(continuedDocument.messages.length, 4);
  assert.equal(continuedDocument.agent_messages.at(-1).role, "assistant");

  await reloaded.handle(
    createCommand("session_delete", {
      project_id: projectId,
      session_id: firstSessionId,
    }),
  );
  assert.equal(latestState(reloadedEvents).active_session_id, secondSessionId);
  assert.equal(latestState(reloadedEvents).sessions.length, 1);
});

test("abort bypasses catalog serialization and checkpoints a terminal assistant", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const core = new ResearchBoxCore({
    projectStore: store,
    workspaceProvider: provider,
    modelTransport: {
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
    },
    model,
    systemPrompt: "You are a test agent.",
    eventSink: (event) => events.push(event),
  });
  await core.handle(createCommand("bootstrap", {}));
  const state = latestState(events);
  const prompt = core.handle(
    createCommand("prompt", {
      project_id: state.active_project_id,
      session_id: state.active_session_id,
      text: "Wait forever",
    }),
  );
  await started;
  await core.handle(
    createCommand("project_update", {
      project_id: state.active_project_id,
      name: "Must not interrupt",
    }),
  );
  assert.equal((await store.load()).projects[0].name, "Local workspace");
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).payload.code, "run_in_progress");
  await core.handle(
    createCommand("abort", {
      project_id: state.active_project_id,
      session_id: state.active_session_id,
    }),
  );
  await prompt;

  const document = (await store.load()).documents[0];
  assert.equal(document.messages.at(-1).status, "aborted");
  assert.equal(document.agent_messages.at(-1).role, "assistant");
  assert.equal(document.agent_messages.at(-1).stop_reason, "aborted");
});

test("projects own isolated filesystems and deleting the last project replaces it", async () => {
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
  assert.equal(second.projects.length, 2);

  await core.handle(
    createCommand("fs_read", {
      project_id: secondProjectId,
      path: "/only-a.txt",
    }),
  );
  assert.equal(events.at(-1).type, "error");
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
  assert.equal(events.at(-1).type, "file_content");
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
  assert.notEqual(replacement.active_project_id, firstProjectId);
  assert.notEqual(replacement.active_project_id, secondProjectId);
});

test("reload quarantines malformed persisted Pi transcripts", async () => {
  const store = new MemoryProjectStore();
  const provider = createWorkspaceProvider();
  const events = [];
  const core = createCore(store, provider, events);
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(
    createCommand("session_create", {
      project_id: initial.active_project_id,
    }),
  );

  const corrupted = await store.load();
  const firstSession = corrupted.sessions.find(
    (session) => session.session_id === initial.active_session_id,
  );
  corrupted.documents.find(
    (document) => document.session_id === firstSession.session_id,
  ).agent_messages = [{ role: "custom", content: [] }];
  const expectedRevision = corrupted.state_revision;
  corrupted.state_revision += 1;
  await store.save(corrupted, expectedRevision);

  const reloadedEvents = [];
  const reloaded = createCore(store, provider, reloadedEvents);
  await reloaded.handle(createCommand("bootstrap", {}));
  await reloaded.handle(
    createCommand("session_select", {
      project_id: initial.active_project_id,
      session_id: firstSession.session_id,
    }),
  );

  assert.deepEqual(
    (await store.load()).documents.find(
      (document) => document.session_id === firstSession.session_id,
    ).agent_messages,
    [],
  );
  assert.equal(latestState(reloadedEvents).active_session_id, firstSession.session_id);
});

function createCore(store, provider, events) {
  return new ResearchBoxCore({
    projectStore: store,
    workspaceProvider: provider,
    modelTransport: {
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
    .find((candidate) =>
      candidate.type === "ready" || candidate.type === "state_snapshot",
    );
  assert.ok(event, "Expected an authoritative state event");
  return event.payload.state;
}
