import assert from "node:assert/strict";
import test from "node:test";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import {
  createDshrboxCore,
  dshrboxToolCallBlockId,
} from "../src/index.ts";

class ScriptedAdapter extends LlmAdapter {
  constructor(script) {
    super();
    this.script = script;
    this.blocked = new Promise((resolve) => {
      this.resolveBlocked = resolve;
    });
  }

  async waitUntilBlocked() {
    await this.blocked;
  }

  async *stream(options) {
    const text = this.script.kind === "text"
      ? this.script.text
      : this.script.partial_text;
    yield { type: "block-start", index: 0, blockType: "text" };
    for (const character of text) {
      yield { type: "text-delta", index: 0, text: character };
    }
    if (this.script.kind === "wait_for_cancel") {
      this.resolveBlocked();
      await new Promise((_resolve, reject) => {
        const abort = () => reject(new Error("test stream aborted"));
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
      });
      return;
    }
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield {
      type: "usage",
      usage: { inputTokens: 1, outputTokens: text.length },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

test("composes DSH and preserves raw session events", async () => {
  const core = await createDshrboxCore({
    llm_adapter: new ScriptedAdapter({ kind: "text", text: "core reply" }),
    max_parallel_tool_calls: 3,
    model: "test-model",
    provider: "core-streaming-test",
    session_id: "core-streaming-test",
  });
  const events = [];
  const unsubscribe = core.runtime.subscribe((event) => events.push(event));
  try {
    await core.runtime.run("Test the core runtime.");
    assert.equal(core.context.agentLoop.config.maxParallelToolCalls, 3);
    assert.ok(events.some((event) => event.type === "assistant/chunk"));
    assert.ok(events.some((event) => event.type === "assistant/message"));
    assert.equal(
      events.findLast((event) => event.type === "turn/end")?.data.reason.kind,
      "completed",
    );
  } finally {
    unsubscribe();
    await core.dispose();
  }
});

test("refuses an overlapping run without a platform-specific policy", async () => {
  const adapter = new ScriptedAdapter({
    kind: "wait_for_cancel",
    partial_text: "partial",
  });
  const core = await createDshrboxCore({
    llm_adapter: adapter,
    model: "fake-streaming-model",
    provider: "dshrbox-overlap-test",
    session_id: "dshrbox-overlap-test",
  });
  try {
    const activeRun = core.runtime.run("First turn.");
    await adapter.waitUntilBlocked();
    await assert.rejects(
      core.runtime.run("Overlapping turn."),
      /already has an active run/u,
    );
    core.runtime.cancel();
    await activeRun;
  } finally {
    await core.dispose();
  }
});

test("builds stable encoded identities for native DSH tool calls", () => {
  assert.equal(
    dshrboxToolCallBlockId("session/one", 2, 3, "call:one"),
    "dshrbox:session%2Fone:turn:2:step:3:assistant:tool-call:call%3Aone",
  );
  assert.throws(
    () => dshrboxToolCallBlockId("", 0, 0, "call"),
    /session_id/u,
  );
  assert.throws(
    () => dshrboxToolCallBlockId("session", -1, 0, "call"),
    /turn/u,
  );
});
