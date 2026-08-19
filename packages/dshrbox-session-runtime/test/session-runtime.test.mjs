import assert from "node:assert/strict";
import test from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session";
import { MemoryDshrboxSessionBackend } from "@dshrbox/session-persistence";
import { DshrboxSessionRuntimeProvider } from "@dshrbox/session-runtime";
import { ResearchBoxCore } from "@researchbox/agent-core";
import { MemoryProjectStore } from "@researchbox/project-store";
import {
  createCommand,
  parseCoreEvent,
} from "@researchbox/protocol";
import {
  MemoryFileSystem,
  MemoryWorkspaceBackend,
} from "@researchbox/vfs";

const model = {
  id: "dsh-model",
  name: "DSH model",
  api: "openai-completions",
  provider: "dsh-provider",
  baseUrl: "",
  reasoning: true,
  supports_tools: true,
  supports_reasoning_effort: true,
  reasoning_efforts: ["none", "low", "high"],
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

class ResumableWorkspaceTransport {
  requestCount = 0;
  observedRestoredHistory = false;

  async *stream(request) {
    const requestIndex = this.requestCount;
    this.requestCount += 1;
    if (requestIndex === 0) {
      assert.deepEqual(
        request.tools.map((tool) => tool.name).sort(),
        ["list_files", "read_file", "search_files"],
      );
      yield* toolCallEvents({
        tool_call_id: "read-note",
        tool_name: "read_file",
        arguments: { path: "/note.txt" },
      });
      yield { type: "done", stop_reason: "tool_use" };
      return;
    }
    if (requestIndex === 1) {
      const result = request.messages.find(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "read-note",
      );
      assert.equal(result?.content, "Persisted workspace content.");
      yield* textEvents("The note was read through DSH.");
      yield { type: "done", stop_reason: "stop" };
      return;
    }
    if (requestIndex === 2) {
      this.observedRestoredHistory = request.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content_blocks.some(
            (block) =>
              block.type === "text" &&
              block.text === "The note was read through DSH.",
          ),
      );
      yield* textEvents("The restored DSH session continued.");
      yield { type: "done", stop_reason: "stop" };
      return;
    }
    throw new Error(`Unexpected DSH request ${requestIndex}.`);
  }
}

class BlockingTransport {
  constructor() {
    this.blocked = new Promise((resolve) => {
      this.resolveBlocked = resolve;
    });
  }

  waitUntilBlocked() {
    return this.blocked;
  }

  async *stream(_request, signal) {
    yield { type: "text_start", content_index: 0 };
    yield {
      type: "text_delta",
      content_index: 0,
      text_delta: "partial DSH output",
    };
    this.resolveBlocked();
    await new Promise((_resolve, reject) => {
      const abort = () => reject(
        new DOMException("The DSH request was aborted.", "AbortError"),
      );
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class ReasoningEffortTransport {
  observedReasoningEffort = null;

  async *stream(request) {
    this.observedReasoningEffort = request.reasoning_effort ?? null;
    yield* textEvents("Reasoning effort received.");
    yield { type: "done", stop_reason: "stop" };
  }
}

class FailingTransport {
  async *stream() {
    yield { type: "text_start", content_index: 0 };
    yield {
      type: "text_delta",
      content_index: 0,
      text_delta: "output before failure",
    };
    throw new Error("Test model transport failed.");
  }
}

class LegacyFallbackTransport {
  toolNames = [];

  async *stream(request) {
    this.toolNames.push(request.tools.map((tool) => tool.name));
    yield* textEvents("Legacy runtime response.");
    yield { type: "done", stop_reason: "stop" };
  }
}

test("runs and restores a DSH session behind the existing rrbox core", async () => {
  const store = new MemoryProjectStore();
  const workspace = createWorkspaceBackend();
  const transport = new ResumableWorkspaceTransport();
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const firstEvents = [];
  const first = createCore(
    store,
    workspace,
    transport,
    firstEvents,
    true,
    sessionBackend,
  );
  await first.handle(createCommand("bootstrap", {}));
  const initial = latestState(firstEvents);
  await first.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Read the workspace note.",
  }));

  const firstState = latestState(firstEvents);
  assert.notEqual(firstState.active_session_id, null);
  assert.equal(firstState.history, undefined);
  assert.deepEqual(
    firstState.timeline.map((entry) => entry.type),
    [
      "user_message",
      "assistant_message",
      "tool_result",
      "assistant_message",
    ],
  );
  assert.equal(firstState.timeline[0].content, "Read the workspace note.");
  assert.equal(
    firstState.timeline.at(-1).blocks[0].text,
    "The note was read through DSH.",
  );
  for (const [index, event] of firstEvents.entries()) {
    assert.deepEqual(
      parseCoreEvent(event),
      event,
      `CoreEvent ${index} should satisfy the viewer protocol.`,
    );
  }
  const afterFirstRun = await store.load();
  const firstDocument = afterFirstRun.documents[0];
  assert.equal(firstDocument.runtime_id, "dsh");
  assert.equal(firstDocument.timeline, undefined);
  assert.equal(firstDocument.history, undefined);
  assert.ok(
    (await sessionBackend.loadStored(SessionId(firstDocument.session_id)))
      .events.length > 0,
  );
  await first.handle(createCommand("session_history_navigate", {
    project_id: firstState.active_project_id,
    session_id: firstState.active_session_id,
    target_node_id: null,
  }));
  const navigationError = firstEvents.findLast(
    (event) => event.type === "error",
  );
  assert.equal(navigationError.payload.code, "session_history_navigation_failed");
  await first.dispose();

  const secondEvents = [];
  const second = createCore(
    store,
    workspace,
    transport,
    secondEvents,
    true,
    sessionBackend,
  );
  await second.handle(createCommand("bootstrap", {
    active_project_id: firstState.active_project_id,
    active_session_id: firstState.active_session_id,
  }));
  const restored = latestState(secondEvents);
  assert.deepEqual(restored.timeline, firstState.timeline);

  await second.handle(createCommand("prompt", {
    project_id: restored.active_project_id,
    session_id: restored.active_session_id,
    text: "Continue from the restored session.",
  }));
  const continued = latestState(secondEvents);
  assert.equal(transport.observedRestoredHistory, true);
  assert.deepEqual(
    continued.timeline.filter((entry) => entry.type === "user_message")
      .map((entry) => entry.content),
    ["Read the workspace note.", "Continue from the restored session."],
  );
  assert.equal(
    continued.timeline.at(-1).blocks[0].text,
    "The restored DSH session continued.",
  );
  await second.dispose();
});

test("routes the existing abort command into DSH and checkpoints partial output", async () => {
  const store = new MemoryProjectStore();
  const workspace = createWorkspaceBackend();
  const transport = new BlockingTransport();
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const events = [];
  const core = createCore(
    store,
    workspace,
    transport,
    events,
    true,
    sessionBackend,
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const prompting = core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Start a response and wait.",
  }));
  await transport.waitUntilBlocked();
  const running = latestState(events);
  assert.notEqual(running.active_session_id, null);
  await core.handle(createCommand("abort", {
    project_id: running.active_project_id,
    session_id: running.active_session_id,
  }));
  await prompting;

  const finished = latestState(events);
  const assistant = finished.timeline.findLast(
    (entry) => entry.type === "assistant_message",
  );
  assert.equal(assistant.status, "aborted");
  assert.equal(assistant.stop_reason, "aborted");
  assert.equal(assistant.blocks[0].text, "partial DSH output");
  assert.equal(finished.is_running, false);
  const stored = await store.load();
  assert.equal(stored.documents[0].timeline, undefined);
  const persisted = await sessionBackend.loadStored(
    SessionId(stored.documents[0].session_id),
  );
  assert.equal(
    persisted.events.at(-1).type,
    "turn/end",
  );
  await core.dispose();
});

test("forwards the existing reasoning-effort selection through DSH", async () => {
  const store = new MemoryProjectStore();
  const workspace = createWorkspaceBackend();
  const transport = new ReasoningEffortTransport();
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const events = [];
  const core = createCore(
    store,
    workspace,
    transport,
    events,
    true,
    sessionBackend,
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(createCommand("reasoning_effort_select", {
    project_id: initial.active_project_id,
    session_id: null,
    reasoning_effort: "high",
  }));
  assert.equal(latestState(events).active_reasoning_effort, "high");
  await core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Use the selected reasoning effort.",
  }));
  assert.equal(transport.observedReasoningEffort, "high");
  await core.dispose();
});

test("durably checkpoints a failed DSH turn", async () => {
  const store = new MemoryProjectStore();
  const workspace = createWorkspaceBackend();
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const events = [];
  const core = createCore(
    store,
    workspace,
    new FailingTransport(),
    events,
    true,
    sessionBackend,
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Fail after emitting partial output.",
  }));

  const finished = latestState(events);
  const assistant = finished.timeline.findLast(
    (entry) => entry.type === "assistant_message",
  );
  assert.equal(assistant.status, "error");
  assert.equal(assistant.stop_reason, "error");
  assert.equal(finished.is_running, false);
  const stored = await store.load();
  assert.equal(stored.documents[0].timeline, undefined);
  const persisted = await sessionBackend.loadStored(
    SessionId(stored.documents[0].session_id),
  );
  assert.equal(
    persisted.events.at(-1).type,
    "turn/end",
  );
  await core.dispose();
});

test("keeps unmarked existing sessions on the legacy runtime", async () => {
  const store = new MemoryProjectStore();
  const workspace = createWorkspaceBackend();
  const transport = new LegacyFallbackTransport();
  const legacyEvents = [];
  const legacy = createCore(
    store,
    workspace,
    transport,
    legacyEvents,
    false,
  );
  await legacy.handle(createCommand("bootstrap", {}));
  const initial = latestState(legacyEvents);
  await legacy.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Create a legacy session.",
  }));
  const legacyState = latestState(legacyEvents);
  await legacy.dispose();

  const dshConfiguredEvents = [];
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const dshConfigured = createCore(
    store,
    workspace,
    transport,
    dshConfiguredEvents,
    true,
    sessionBackend,
  );
  await dshConfigured.handle(createCommand("bootstrap", {
    active_project_id: legacyState.active_project_id,
    active_session_id: legacyState.active_session_id,
  }));
  await dshConfigured.handle(createCommand("prompt", {
    project_id: legacyState.active_project_id,
    session_id: legacyState.active_session_id,
    text: "Continue without migrating runtimes.",
  }));
  const stored = await store.load();
  assert.equal(stored.documents[0].runtime_id, undefined);
  assert.ok(transport.toolNames.at(-1).includes("write_file"));
  await dshConfigured.dispose();
});

function createCore(
  store,
  workspace,
  transport,
  events,
  useDsh = true,
  sessionBackend = new MemoryDshrboxSessionBackend(),
) {
  return new ResearchBoxCore({
    projectStore: store,
    workspaceBackend: workspace,
    modelTransport: transport,
    model,
    systemPrompt: "You are a DSH session-runtime test agent.",
    eventSink: (event) => events.push(event),
    ...(useDsh
      ? {
          sessionRuntimeProvider: new DshrboxSessionRuntimeProvider({
            session_backend: sessionBackend,
            // Force the terminal batch through executeRun's explicit flush so
            // the final checkpoint overlaps a ProjectStore refresh.
            write_batch_max_delay_ms: 10_000,
          }),
        }
      : {}),
  });
}

function createWorkspaceBackend() {
  const defaults = [{
    path: "/note.txt",
    content: "Persisted workspace content.",
  }];
  return new MemoryWorkspaceBackend(
    (initialFiles) => new MemoryFileSystem(Object.fromEntries(
      (initialFiles ?? defaults).map(({ path, content }) => [path, content]),
    )),
  );
}

function latestState(events) {
  const event = events.findLast(
    (candidate) =>
      candidate.type === "ready" || candidate.type === "state_snapshot",
  );
  assert.ok(event, "Expected a ready or state_snapshot event.");
  return event.payload.state;
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
