import assert from "node:assert/strict";
import test from "node:test";
import {
  createDshrboxBrowserCore,
  DSH_BROWSER_COMPATIBILITY,
} from "../src/index.ts";
import { ProbeLlmAdapter } from "./fixtures/probe-adapter.ts";
import { runDshrboxBrowserProbe } from "./fixtures/probe.ts";

test("composes the constrained browser runtime over core", async () => {
  const result = await runDshrboxBrowserProbe();

  assert.equal(result.ok, true);
  assert.equal(result.dsh_version, "0.1.1-rc.2");
  assert.equal(result.streaming.text, "DSH streams in a browser worker.");
  assert.equal(result.streaming.turn_end_kind, "completed");
  assert.ok(result.streaming.event_types.includes("assistant/chunk"));
  assert.ok(result.streaming.event_types.includes("assistant/message"));
  assert.equal(result.cancellation.text, "partial");
  assert.equal(result.cancellation.turn_end_kind, "aborted");
  assert.equal(result.workspace.tool_name, "read_file");
  assert.equal(result.workspace.result_text, "Browser workspace content.");
  assert.equal(result.workspace.model_observed_result, true);
  assert.equal(result.workspace.turn_end_kind, "completed");
  assert.deepEqual(result.workspace.projected_timeline_types, [
    "user_message",
    "assistant_message",
    "tool_result",
    "assistant_message",
  ]);
  assert.ok(
    result.workspace.projected_event_types.includes(
      "timeline_entry_appended",
    ),
  );
  assert.ok(result.workspace.event_types.includes("tool/call"));
  assert.ok(result.workspace.event_types.includes("tool/result"));
  assert.equal(result.session_runtime.runtime_id, "dsh");
  assert.ok(result.session_runtime.persisted_event_count > 0);
  assert.deepEqual(result.session_runtime.timeline_types, [
    "user_message",
    "assistant_message",
    "tool_result",
    "assistant_message",
  ]);
});

test("declares the constrained browser async-context contract", () => {
  assert.deepEqual(DSH_BROWSER_COMPATIBILITY, {
    async_context: "single_foreground_chain",
    max_live_agents: 1,
    max_parallel_tool_calls: 1,
  });
});

test("fixes browser tool execution to the safe serial limit", async () => {
  const core = await createDshrboxBrowserCore({
    llm_adapter: new ProbeLlmAdapter({ kind: "text", text: "unused" }),
    model: "fake-streaming-model",
    provider: "dshrbox-browser-policy-test",
    session_id: "dshrbox-browser-policy-test",
  });
  try {
    assert.equal(core.context.agentLoop.config.maxParallelToolCalls, 1);
  } finally {
    await core.dispose();
  }
});
