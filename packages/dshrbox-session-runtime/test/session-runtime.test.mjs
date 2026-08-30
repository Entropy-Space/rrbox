import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionId,
  TOOL_OUTCOME_UNKNOWN,
} from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { MemoryDshrboxSessionBackend } from "@dshrbox/session-persistence";
import { DshrboxSessionRuntimeProvider } from "@dshrbox/session-runtime";
import { DshrboxPython } from "@researchbox/python-plugin/dsh";
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
        [
          "list_files",
          "read_file",
          "remove_file",
          "replace_text",
          "search_files",
          "write_file",
        ],
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

class NativePythonTransport {
  requestCount = 0;

  async *stream(request) {
    const requestIndex = this.requestCount;
    this.requestCount += 1;
    if (requestIndex === 0) {
      assert.ok(request.tools.some((tool) => tool.name === "run_python"));
      yield* toolCallEvents({
        tool_call_id: "python-call",
        tool_name: "run_python",
        arguments: { code: "print(6 * 7)" },
      });
      yield { type: "done", stop_reason: "tool_use" };
      return;
    }
    if (requestIndex === 1) {
      const result = request.messages.find(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "python-call",
      );
      assert.equal(result?.content, "stdout:\n42\n");
      yield* textEvents("Python returned 42.");
      yield { type: "done", stop_reason: "stop" };
      return;
    }
    throw new Error(`Unexpected native-Python request ${requestIndex}.`);
  }
}

class NativeWorkspaceMutationTransport {
  requestCount = 0;

  async *stream(request) {
    const requestIndex = this.requestCount;
    this.requestCount += 1;
    if (requestIndex === 0) {
      assert.ok(request.tools.some((tool) => tool.name === "write_file"));
      assert.ok(request.tools.some((tool) => tool.name === "replace_text"));
      assert.ok(request.tools.some((tool) => tool.name === "remove_file"));
      yield* toolCallEvents({
        tool_call_id: "write-note",
        tool_name: "write_file",
        arguments: {
          path: "/notes/agent-note.md",
          content: "# Agent note\n\nfirst draft\n",
        },
      });
      yield { type: "done", stop_reason: "tool_use" };
      return;
    }
    if (requestIndex === 1) {
      assertMutationResult(request, "write-note", "created");
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
    if (requestIndex === 2) {
      assertMutationResult(request, "revise-note", "updated");
      yield* toolCallEvents({
        tool_call_id: "remove-note",
        tool_name: "remove_file",
        arguments: { path: "/notes/agent-note.md" },
      });
      yield { type: "done", stop_reason: "tool_use" };
      return;
    }
    if (requestIndex === 3) {
      assertMutationResult(request, "remove-note", "deleted");
      yield* textEvents("The note was removed through DSH.");
      yield { type: "done", stop_reason: "stop" };
      return;
    }
    throw new Error(`Unexpected workspace-mutation request ${requestIndex}.`);
  }
}

class RecoverableWorkspaceMutationTransport {
  requestCount = 0;
  observedRecoveredResult = false;

  async *stream(request) {
    const requestIndex = this.requestCount;
    this.requestCount += 1;
    if (requestIndex === 0) {
      yield* toolCallEvents({
        tool_call_id: "recover-write",
        tool_name: "write_file",
        arguments: {
          path: "/notes/recovered.md",
          content: "# Recovered\n\nDurable workspace content.\n",
        },
      });
      yield { type: "done", stop_reason: "tool_use" };
      return;
    }
    if (requestIndex === 1) {
      assertMutationResult(request, "recover-write", "created");
      yield* textEvents("The workspace write completed.");
      yield { type: "done", stop_reason: "stop" };
      return;
    }
    if (requestIndex === 2) {
      assertMutationResult(request, "recover-write", "created");
      this.observedRecoveredResult = true;
      yield* textEvents("The recovered DSH session continued.");
      yield { type: "done", stop_reason: "stop" };
      return;
    }
    throw new Error(`Unexpected recoverable-mutation request ${requestIndex}.`);
  }
}

class SummaryReviewTransport {
  requestCount = 0;
  observedDecision = null;

  async *stream(request) {
    const requestIndex = this.requestCount;
    this.requestCount += 1;
    if (requestIndex === 0) {
      assert.ok(
        request.tools.some((tool) => tool.name === "request_summary_review"),
      );
      yield* toolCallEvents({
        tool_call_id: "summary-review-call",
        tool_name: "request_summary_review",
        arguments: {},
      });
      yield { type: "done", stop_reason: "tool_use" };
      return;
    }
    if (requestIndex === 1) {
      const result = request.messages.find(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "summary-review-call",
      );
      this.observedDecision = result?.content ?? null;
      yield* textEvents("The reviewed evidence was accepted.");
      yield { type: "done", stop_reason: "stop" };
      return;
    }
    throw new Error(`Unexpected summary-review request ${requestIndex}.`);
  }
}

class FailingDeleteSessionBackend extends MemoryDshrboxSessionBackend {
  async deleteStored() {
    throw new Error("Test DSH session deletion failed.");
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

test("composes native DSH plugins and projects their result metadata", async () => {
  const calls = [];
  const events = [];
  const executor = {
    async execute(code, signal) {
      calls.push({ code, signal });
      return {
        stdout: "42\n",
        stderr: "",
        error: null,
        output_truncated: false,
      };
    },
    close() {},
  };
  const core = createCore(
    new MemoryProjectStore(),
    createWorkspaceBackend(),
    new NativePythonTransport(),
    events,
    true,
    new MemoryDshrboxSessionBackend(),
    [{ plugin: DshrboxPython, config: { executor } }],
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Calculate with Python.",
  }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].code, "print(6 * 7)");
  assert.ok(calls[0].signal instanceof AbortSignal);
  const state = latestState(events);
  const result = state.timeline.find(
    (entry) =>
      entry.type === "tool_result" &&
      entry.tool_name === "run_python",
  );
  assert.equal(result?.content, "stdout:\n42\n");
  assert.equal(result?.summary, "Python completed");
  assert.equal(state.timeline.at(-1).blocks[0].text, "Python returned 42.");
  await core.dispose();
});

test("journals native DSH workspace mutations for the existing viewer", async () => {
  const store = new MemoryProjectStore();
  const workspaceBackend = createWorkspaceBackend();
  const events = [];
  const core = createCore(
    store,
    workspaceBackend,
    new NativeWorkspaceMutationTransport(),
    events,
    true,
    new MemoryDshrboxSessionBackend(),
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Create, revise, and remove a note through DSH.",
  }));

  const state = latestState(events);
  assert.equal(state.workspace_revision, 3);
  const workspace = await workspaceBackend.open(initial.active_project_id);
  await assert.rejects(
    workspace.read("/notes/agent-note.md"),
    (error) => error?.code === "not_found",
  );
  const { changes } = await workspace.listChanges();
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
        after_content: "# Agent note\n\nfirst draft\n",
      },
      {
        tool_call_id: "revise-note",
        tool_name: "replace_text",
        path: "/notes/agent-note.md",
        change_kind: "updated",
        before_content: "# Agent note\n\nfirst draft\n",
        after_content: "# Agent note\n\nready to review\n",
      },
      {
        tool_call_id: "remove-note",
        tool_name: "remove_file",
        path: "/notes/agent-note.md",
        change_kind: "deleted",
        before_content: "# Agent note\n\nready to review\n",
        after_content: null,
      },
    ],
  );

  const toolResults = state.timeline.filter(
    (entry) => entry.type === "tool_result",
  );
  assert.deepEqual(
    toolResults.map((entry) => ({
      tool_call_id: entry.tool_call_id,
      is_error: entry.is_error,
      path: entry.file_change?.path,
      change_kind: entry.file_change?.change_kind,
      summary: entry.summary,
    })),
    [
      {
        tool_call_id: "write-note",
        is_error: false,
        path: "/notes/agent-note.md",
        change_kind: "created",
        summary: "Created · +3 −0",
      },
      {
        tool_call_id: "revise-note",
        is_error: false,
        path: "/notes/agent-note.md",
        change_kind: "updated",
        summary: "Updated · +1 −1",
      },
      {
        tool_call_id: "remove-note",
        is_error: false,
        path: "/notes/agent-note.md",
        change_kind: "deleted",
        summary: "Deleted · +0 −3",
      },
    ],
  );
  const toolCalls = state.timeline
    .filter((entry) => entry.type === "assistant_message")
    .flatMap((entry) => entry.blocks)
    .filter((block) => block.type === "tool_call");
  for (const result of toolResults) {
    const call = toolCalls.find(
      (block) => block.tool_call_id === result.tool_call_id,
    );
    const change = changes.find(
      (candidate) => candidate.tool_call_id === result.tool_call_id,
    );
    assert.ok(call);
    assert.ok(change);
    assert.equal(result.tool_call_block_id, call.block_id);
    assert.equal(change.tool_call_block_id, call.block_id);
    assert.equal(change.session_id, state.active_session_id);
    assert.ok(Number.isSafeInteger(change.assistant_message_index));
  }

  const changeEvents = events.filter(
    (event) => event.type === "workspace_changed",
  );
  assert.deepEqual(
    changeEvents.map((event) => ({
      workspace_revision: event.payload.workspace_revision,
      tool_call_id: event.payload.change.tool_call_id,
      change_kind: event.payload.change.change_kind,
    })),
    [
      {
        workspace_revision: 1,
        tool_call_id: "write-note",
        change_kind: "created",
      },
      {
        workspace_revision: 2,
        tool_call_id: "revise-note",
        change_kind: "updated",
      },
      {
        workspace_revision: 3,
        tool_call_id: "remove-note",
        change_kind: "deleted",
      },
    ],
  );
  for (const event of changeEvents) {
    assert.deepEqual(parseCoreEvent(event), event);
  }

  const deletion = changes.at(-1);
  const read = createCommand("workspace_change_read", {
    project_id: initial.active_project_id,
    change_id: deletion.change_id,
  });
  await core.handle(read);
  const inspected = events.at(-1);
  assert.equal(inspected.type, "workspace_change_snapshot");
  assert.equal(inspected.request_id, read.request_id);
  assert.equal(inspected.payload.change.revert_status, "available");
  assert.equal(inspected.payload.change.current_content, null);

  const revert = createCommand("workspace_change_revert", {
    project_id: initial.active_project_id,
    change_id: deletion.change_id,
  });
  await core.handle(revert);
  const reverted = events.at(-1);
  assert.equal(reverted.type, "workspace_change_reverted");
  assert.equal(reverted.request_id, revert.request_id);
  assert.equal(reverted.payload.revert_outcome, "applied");
  assert.equal(
    (await workspace.read("/notes/agent-note.md")).content,
    "# Agent note\n\nready to review\n",
  );
  await core.dispose();
});

test("recovers a committed workspace mutation after a DSH result crash", async () => {
  const store = new MemoryProjectStore();
  const workspaceBackend = createWorkspaceBackend();
  const transport = new RecoverableWorkspaceMutationTransport();
  const completeBackend = new MemoryDshrboxSessionBackend();
  const firstEvents = [];
  const first = createCore(
    store,
    workspaceBackend,
    transport,
    firstEvents,
    true,
    completeBackend,
  );
  await first.handle(createCommand("bootstrap", {}));
  const initial = latestState(firstEvents);
  await first.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Write a file whose result can be recovered.",
  }));
  const completed = latestState(firstEvents);
  const sessionId = SessionId(completed.active_session_id);
  await first.dispose();

  const completeStored = await completeBackend.loadStored(sessionId);
  assert.ok(completeStored);
  const callIndex = completeStored.events.findIndex(
    (event) =>
      event.type === "tool/call" &&
      String(event.data.callId) === "recover-write",
  );
  assert.notEqual(callIndex, -1);
  const crashPrefix = completeStored.events.slice(0, callIndex + 1);

  const unprovenBackend = new MemoryDshrboxSessionBackend();
  await unprovenBackend.appendBatch(
    completeStored.meta,
    crashPrefix,
    false,
  );
  const unprovenWorkspaceBackend = createWorkspaceBackend();
  await unprovenWorkspaceBackend.create(completed.active_project_id);
  const unprovenEvents = [];
  const unproven = createCore(
    store,
    unprovenWorkspaceBackend,
    transport,
    unprovenEvents,
    true,
    unprovenBackend,
  );
  await unproven.handle(createCommand("bootstrap", {
    active_project_id: completed.active_project_id,
    active_session_id: completed.active_session_id,
  }));
  const unknownResult = latestState(unprovenEvents).timeline.find(
    (entry) =>
      entry.type === "tool_result" &&
      entry.tool_call_id === "recover-write",
  );
  assert.ok(unknownResult);
  assert.equal(unknownResult.is_error, true);
  assert.equal(unknownResult.file_change, undefined);
  const unprovenStored = await unprovenBackend.loadStored(sessionId);
  assert.equal(
    unprovenStored.events.find(
      (event) =>
        event.type === "tool/result" &&
        String(event.data.message.source.callId) === "recover-write",
    )?.data.error?.code,
    TOOL_OUTCOME_UNKNOWN,
  );
  await unproven.dispose();

  const crashedBackend = new MemoryDshrboxSessionBackend();
  await crashedBackend.appendBatch(
    completeStored.meta,
    crashPrefix,
    false,
  );

  const secondEvents = [];
  const second = createCore(
    store,
    workspaceBackend,
    transport,
    secondEvents,
    true,
    crashedBackend,
  );
  await second.handle(createCommand("bootstrap", {
    active_project_id: completed.active_project_id,
    active_session_id: completed.active_session_id,
  }));

  const recovered = latestState(secondEvents);
  const result = recovered.timeline.find(
    (entry) =>
      entry.type === "tool_result" &&
      entry.tool_call_id === "recover-write",
  );
  assert.ok(result);
  assert.equal(result.is_error, false);
  assert.equal(result.summary, "Created · +3 −0");
  assert.equal(result.file_change?.path, "/notes/recovered.md");
  assert.equal(result.file_change?.change_kind, "created");
  assert.equal(recovered.workspace_revision, 1);

  const workspace = await workspaceBackend.open(completed.active_project_id);
  assert.equal(
    (await workspace.read("/notes/recovered.md")).content,
    "# Recovered\n\nDurable workspace content.\n",
  );
  const { changes } = await workspace.listChanges();
  const change = changes.find(
    (candidate) => candidate.tool_call_id === "recover-write",
  );
  assert.ok(change);
  assert.equal(result.tool_call_block_id, change.tool_call_block_id);

  const inspectedCommand = createCommand("workspace_change_read", {
    project_id: completed.active_project_id,
    change_id: change.change_id,
  });
  await second.handle(inspectedCommand);
  const inspected = secondEvents.at(-1);
  assert.equal(inspected.type, "workspace_change_snapshot");
  assert.equal(inspected.request_id, inspectedCommand.request_id);
  assert.equal(inspected.payload.change.revert_status, "available");

  const repairedStored = await crashedBackend.loadStored(sessionId);
  const repairedResults = repairedStored.events.filter(
    (event) =>
      event.type === "tool/result" &&
      String(event.data.message.source.callId) === "recover-write",
  );
  assert.equal(repairedResults.length, 1);
  assert.equal(
    repairedResults[0].data.message.content[0].isError,
    false,
  );
  assert.equal(repairedResults[0].data.error, undefined);
  assert.equal(
    repairedStored.events.some(
      (event) =>
        event.type === "tool/result" &&
        event.data.error?.code === TOOL_OUTCOME_UNKNOWN,
    ),
    false,
  );

  await second.handle(createCommand("prompt", {
    project_id: recovered.active_project_id,
    session_id: recovered.active_session_id,
    text: "Continue after recovering the workspace result.",
  }));
  assert.equal(transport.observedRecoveredResult, true);
  assert.equal(
    latestState(secondEvents).timeline.at(-1).blocks[0].text,
    "The recovered DSH session continued.",
  );
  await second.dispose();

  const persistedAfterContinuation = await crashedBackend.loadStored(sessionId);
  assert.equal(
    persistedAfterContinuation.events.filter(
      (event) =>
        event.type === "tool/result" &&
        String(event.data.message.source.callId) === "recover-write",
    ).length,
    1,
  );
});

test("routes summary-review commands into a native DSH interaction", async () => {
  const events = [];
  const transport = new SummaryReviewTransport();
  const core = createCore(
    new MemoryProjectStore(),
    createWorkspaceBackend(),
    transport,
    events,
    true,
    new MemoryDshrboxSessionBackend(),
    [{ plugin: SummaryReviewTestPlugin }],
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  const prompting = core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Ask me to review the evidence.",
  }));
  const requested = await waitForEvent(
    events,
    (event) => event.type === "summary_review_requested",
  );
  assert.deepEqual(parseCoreEvent(requested), requested);

  await core.handle(createCommand("summary_review_visibility", {
    project_id: requested.payload.project_id,
    session_id: requested.payload.session_id,
    interaction_id: requested.payload.interaction_id,
    is_visible: false,
  }));
  await core.handle(createCommand("summary_review_touch", {
    project_id: requested.payload.project_id,
    session_id: requested.payload.session_id,
    interaction_id: requested.payload.interaction_id,
  }));
  await core.handle(createCommand("summary_review_resolve", {
    project_id: requested.payload.project_id,
    session_id: requested.payload.session_id,
    interaction_id: requested.payload.interaction_id,
    resolution: {
      decision: "summarize",
      approved_text: "",
      selected_section_ids: ["result-1"],
      feedback_text: "",
      summary_model: null,
      search_provider: "exa",
      query_text: "",
    },
  }));
  await prompting;

  assert.equal(transport.observedDecision, "summary-review:summarize");
  const resolved = events.findLast(
    (event) => event.type === "summary_review_resolved",
  );
  assert.equal(resolved.payload.interaction_id, requested.payload.interaction_id);
  assert.equal(resolved.payload.decision, "summarize");
  assert.deepEqual(parseCoreEvent(resolved), resolved);
  assert.equal(
    latestState(events).timeline.at(-1).blocks[0].text,
    "The reviewed evidence was accepted.",
  );
  await core.dispose();
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

test("deletes DSH persistence after deleting its host session", async () => {
  const store = new MemoryProjectStore();
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const events = [];
  const core = createCore(
    store,
    createWorkspaceBackend(),
    new ReasoningEffortTransport(),
    events,
    true,
    sessionBackend,
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Create a session that will be deleted.",
  }));
  const created = latestState(events);
  const deletedSessionId = created.active_session_id;
  assert.notEqual(
    await sessionBackend.loadStored(SessionId(deletedSessionId)),
    undefined,
  );

  await core.handle(createCommand("session_delete", {
    project_id: created.active_project_id,
    session_id: deletedSessionId,
  }));

  const deleted = latestState(events);
  assert.equal(deleted.sessions.length, 0);
  assert.equal(deleted.active_session_id, null);
  assert.equal(
    await sessionBackend.loadStored(SessionId(deletedSessionId)),
    undefined,
  );
  await core.dispose();
});

test("deletes every DSH session owned by a deleted project", async () => {
  const store = new MemoryProjectStore();
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const events = [];
  const core = createCore(
    store,
    createWorkspaceBackend(),
    new ReasoningEffortTransport(),
    events,
    true,
    sessionBackend,
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Create a session in a project that will be deleted.",
  }));
  const created = latestState(events);
  const deletedProjectId = created.active_project_id;
  const deletedSessionId = created.active_session_id;

  await core.handle(createCommand("project_delete", {
    project_id: deletedProjectId,
  }));

  const deleted = latestState(events);
  assert.equal(
    deleted.projects.some(
      (project) => project.project_id === deletedProjectId,
    ),
    false,
  );
  assert.equal(
    await sessionBackend.loadStored(SessionId(deletedSessionId)),
    undefined,
  );
  await core.dispose();
});

test("keeps host deletion committed when DSH cleanup fails", async () => {
  const store = new MemoryProjectStore();
  const events = [];
  const core = createCore(
    store,
    createWorkspaceBackend(),
    new ReasoningEffortTransport(),
    events,
    true,
    new FailingDeleteSessionBackend(),
  );
  await core.handle(createCommand("bootstrap", {}));
  const initial = latestState(events);
  await core.handle(createCommand("prompt", {
    project_id: initial.active_project_id,
    session_id: null,
    text: "Create a session whose cleanup will fail.",
  }));
  const created = latestState(events);

  await core.handle(createCommand("session_delete", {
    project_id: created.active_project_id,
    session_id: created.active_session_id,
  }));

  assert.equal((await store.load()).sessions.length, 0);
  const cleanupError = events.findLast(
    (event) =>
      event.type === "error" &&
      event.payload.code === "session_cleanup_failed",
  );
  assert.equal(cleanupError.payload.session_id, created.active_session_id);
  assert.match(cleanupError.payload.message, /session deletion failed/);
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
  dshPlugins = [],
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
            plugins: dshPlugins,
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

function assertMutationResult(request, toolCallId, changeKind) {
  const result = request.messages.findLast(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id === toolCallId,
  );
  assert.ok(result);
  assert.equal(result.is_error, false);
  assert.equal(JSON.parse(result.content).change_kind, changeKind);
}

function SummaryReviewTestPlugin(context) {
  context.tools.register(defineTool({
    name: "request_summary_review",
    description: "Request a summary review for a test.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          decision: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `summary-review:${value.decision}`,
      }],
    },
    async execute(_args, execution) {
      const interaction = context.dshrboxSummaryReview.open({
        stage: "select-evidence",
        is_loading: false,
        loading_phase: null,
        auto_submit_at: null,
        title: "Review evidence",
        draft_text: "",
        summary_model: null,
        draft_metadata: null,
        query_draft: "",
        query_notice: null,
        search_providers: [{
          provider_id: "exa",
          display_name: "Exa",
        }],
        search_provider: "exa",
        sections: [{
          section_id: "result-1",
          title: "Result one",
          body: "Evidence",
          is_selectable: true,
          sources: [{ title: "Source", url: "https://example.com" }],
        }],
        selected_section_ids: ["result-1"],
      }, execution.signal);
      const resolution = await interaction.resolution;
      return { decision: resolution.decision };
    },
  }));
}

SummaryReviewTestPlugin.inject = ["dshrboxSummaryReview", "tools"];

async function waitForEvent(events, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = events.find(predicate);
    if (event !== undefined) return event;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for a CoreEvent.");
}
