import assert from "node:assert/strict";
import test from "node:test";
import { ModelTransportLlmAdapter } from "@dshrbox/model-adapter";
import DshrboxWorkspace from "@dshrbox/workspace";
import { MemoryWorkspace } from "@researchbox/vfs";
import { PROTOCOL_VERSION, parseCoreEvent } from "@researchbox/protocol";
import { createDshrboxCore } from "@dshrbox/core";
import {
  coreReducer,
  initialAgentSessionState,
} from "../../viewer/src/use-agent-session.ts";
import DshrboxEventProjection, {
  DshrboxEventProjector,
} from "../src/index.ts";

const PROJECT_ID = "project-alpha";
const PROVIDER_ID = "provider-alpha";
const MODEL_ID = "model-alpha";
const SESSION_ID = "session-alpha";
const TOOL_CALL_ID = "read-note";

class WorkspaceModelTransport {
  constructor() {
    this.requestCount = 0;
    this.observedToolResult = false;
  }

  async *stream(request, signal) {
    if (signal.aborted) throw createAbortError();
    const requestIndex = this.requestCount;
    this.requestCount += 1;
    if (requestIndex === 0) {
      assert.ok(request.tools.some((tool) => tool.name === "read_file"));
      yield { type: "reasoning_start", content_index: 0 };
      yield {
        type: "reasoning_delta",
        content_index: 0,
        reasoning_delta: "I should read the note.",
      };
      yield { type: "reasoning_end", content_index: 0 };
      yield { type: "tool_call_start", content_index: 1 };
      yield {
        type: "tool_call_delta",
        content_index: 1,
        tool_call_id_delta: TOOL_CALL_ID,
        tool_name_delta: "read_file",
        arguments_delta: JSON.stringify({ path: "/note.txt" }),
      };
      yield {
        type: "tool_call_end",
        content_index: 1,
        tool_call: {
          tool_call_id: TOOL_CALL_ID,
          tool_name: "read_file",
          arguments: { path: "/note.txt" },
        },
      };
      yield { type: "done", stop_reason: "tool_use" };
      return;
    }
    if (requestIndex !== 1) {
      throw new Error("Unexpected model request in projector test.");
    }
    const result = request.messages.find(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === TOOL_CALL_ID,
    );
    assert.equal(result?.content, "Projected workspace content.");
    this.observedToolResult = true;
    yield { type: "text_start", content_index: 0 };
    yield {
      type: "text_delta",
      content_index: 0,
      text_delta: "The note was projected.",
    };
    yield { type: "text_end", content_index: 0 };
    yield { type: "done", stop_reason: "stop" };
  }
}

class BlockingModelTransport {
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
    yield { type: "text_delta", content_index: 0, text_delta: "partial" };
    this.resolveBlocked();
    await new Promise((_resolve, reject) => {
      const abort = () => reject(createAbortError());
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

function projectionPlugin(events) {
  return {
    plugin: DshrboxEventProjection,
    config: {
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      event_sink: (event) => events.push(event),
    },
  };
}

function projector() {
  return new DshrboxEventProjector({
    project_id: PROJECT_ID,
    session_id: SESSION_ID,
  });
}

test("projects a real DSH workspace-tool turn into the current timeline", async () => {
  const transport = new WorkspaceModelTransport();
  const projected = [];
  const raw = [];
  const core = await createDshrboxCore({
    llm_adapter: new ModelTransportLlmAdapter(transport),
    model: MODEL_ID,
    provider: PROVIDER_ID,
    session_id: SESSION_ID,
    plugins: [
      projectionPlugin(projected),
      {
        plugin: DshrboxWorkspace,
        config: {
          workspace: new MemoryWorkspace({
            "/note.txt": "Projected workspace content.",
          }),
        },
      },
    ],
  });
  const unsubscribe = core.runtime.subscribe((event) => raw.push(event));
  try {
    await core.runtime.run("Read the workspace note.");
    assert.equal(transport.observedToolResult, true);
    for (const event of projected) {
      assert.deepEqual(parseCoreEvent(event), event);
    }

    const snapshot = core.context.dshrboxProjection.snapshot();
    assert.equal(snapshot.is_running, false);
    assert.equal(snapshot.last_event_seq, raw.at(-1)?.seq);
    assert.deepEqual(
      snapshot.timeline.map((entry) => entry.type),
      [
        "user_message",
        "assistant_message",
        "tool_result",
        "assistant_message",
      ],
    );
    const [user, firstAssistant, toolResult, finalAssistant] =
      snapshot.timeline;
    assert.equal(user.content, "Read the workspace note.");
    assert.equal(firstAssistant.status, "complete");
    assert.equal(firstAssistant.stop_reason, "tool_use");
    assert.deepEqual(
      firstAssistant.blocks.map((block) => block.type),
      ["reasoning", "tool_call"],
    );
    assert.equal(firstAssistant.blocks[0].text, "I should read the note.");
    const toolCall = firstAssistant.blocks[1];
    assert.equal(toolCall.tool_call_id, TOOL_CALL_ID);
    assert.deepEqual(toolCall.arguments, { path: "/note.txt" });
    assert.equal(toolResult.tool_call_block_id, toolCall.block_id);
    assert.equal(toolResult.content, "Projected workspace content.");
    assert.equal(finalAssistant.status, "complete");
    assert.equal(finalAssistant.stop_reason, "stop");
    assert.equal(
      finalAssistant.blocks[0].text,
      "The note was projected.",
    );
    assert.equal(
      snapshot.timeline.every(
        (entry) => entry.run_id === user.run_id,
      ),
      true,
    );

    assert.deepEqual(
      projected
        .filter((event) => event.type === "run_state")
        .map((event) => event.payload.is_running),
      [true, false],
    );
    assert.ok(projected.some(
      (event) =>
        event.type === "assistant_block_delta" &&
        event.payload.block_type === "reasoning",
    ));
    assert.ok(projected.some(
      (event) =>
        event.type === "assistant_block_delta" &&
        event.payload.block_type === "assistant_text",
    ));
    assert.equal(
      new Set(projected.map((event) => event.event_id)).size,
      projected.length,
    );

    let viewerState = coreReducer(
      initialAgentSessionState,
      readyEvent(),
    );
    for (const event of projected) {
      viewerState = coreReducer(viewerState, event);
    }
    assert.deepEqual(viewerState.timeline, snapshot.timeline);
    assert.equal(viewerState.is_running, false);

    const replay = projector();
    const replayedEvents = raw.flatMap((event) => replay.accept(event));
    assert.deepEqual(replayedEvents, projected);
    assert.deepEqual(replay.snapshot(), snapshot);
    assert.deepEqual(replay.accept(raw.at(-1)), []);
  } finally {
    unsubscribe();
    await core.dispose();
  }
});

test("finalizes partial assistant output when DSH aborts a turn", async () => {
  const transport = new BlockingModelTransport();
  const projected = [];
  const raw = [];
  const core = await createDshrboxCore({
    llm_adapter: new ModelTransportLlmAdapter(transport),
    model: MODEL_ID,
    provider: PROVIDER_ID,
    session_id: SESSION_ID,
    plugins: [projectionPlugin(projected)],
  });
  const unsubscribe = core.runtime.subscribe((event) => raw.push(event));
  try {
    const run = core.runtime.run("Start and cancel.");
    await transport.waitUntilBlocked();
    core.runtime.cancel();
    await run;

    const snapshot = core.context.dshrboxProjection.snapshot();
    const assistant = snapshot.timeline.find(
      (entry) => entry.type === "assistant_message",
    );
    assert.equal(assistant.status, "aborted");
    assert.equal(assistant.stop_reason, "aborted");
    assert.equal(assistant.blocks[0].text, "partial");
    assert.equal(
      raw.find((event) => event.type === "assistant/message")
        ?.data.interrupted,
      true,
    );
    assert.equal(snapshot.is_running, false);
    assert.equal(
      projected.findLast((event) => event.type === "run_state")
        ?.payload.is_running,
      false,
    );

    const replay = projector();
    assert.deepEqual(replay.replay(raw), snapshot);
  } finally {
    unsubscribe();
    await core.dispose();
  }
});

test("rejects gaps and conflicting duplicate DSH events", async () => {
  const projected = [];
  const raw = [];
  const core = await createDshrboxCore({
    llm_adapter: new ModelTransportLlmAdapter(
      new WorkspaceModelTransport(),
    ),
    model: MODEL_ID,
    provider: PROVIDER_ID,
    session_id: SESSION_ID,
    plugins: [
      projectionPlugin(projected),
      {
        plugin: DshrboxWorkspace,
        config: {
          workspace: new MemoryWorkspace({
            "/note.txt": "Projected workspace content.",
          }),
        },
      },
    ],
  });
  const unsubscribe = core.runtime.subscribe((event) => raw.push(event));
  try {
    await core.runtime.run("Read the workspace note.");
    const replay = projector();
    replay.replay(raw);
    const last = raw.at(-1);
    assert.throws(
      () => replay.accept({ ...last, time: last.time + 1 }),
      /Conflicting DSH event/u,
    );
    assert.throws(
      () => replay.accept({ ...last, seq: last.seq + 2 }),
      /Expected DSH event seq/u,
    );
  } finally {
    unsubscribe();
    await core.dispose();
  }
});

function createAbortError() {
  return new DOMException("The test model request was aborted.", "AbortError");
}

function readyEvent() {
  const createdAt = "2026-08-18T00:00:00.000Z";
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: "projector-ready",
    type: "ready",
    payload: {
      state: {
        state_revision: 1,
        catalog_revision: 0,
        workspace_revision: 0,
        projects: [{
          project_id: PROJECT_ID,
          name: "Project alpha",
          created_at: createdAt,
          updated_at: createdAt,
        }],
        sessions: [{
          session_id: SESSION_ID,
          project_id: PROJECT_ID,
          title: "Session alpha",
          created_at: createdAt,
          updated_at: createdAt,
          message_count: 0,
        }],
        providers: [],
        active_model: {
          provider_id: PROVIDER_ID,
          model_id: MODEL_ID,
        },
        active_reasoning_effort: "default",
        active_project_id: PROJECT_ID,
        active_session_id: SESSION_ID,
        input_draft: "",
        timeline: [],
        files: [],
        is_running: false,
      },
    },
  };
}
