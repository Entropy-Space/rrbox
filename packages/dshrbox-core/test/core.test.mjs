import assert from "node:assert/strict";
import test from "node:test";
import {
  createDshrboxCore,
  DSH_BROWSER_COMPATIBILITY,
} from "../src/index.ts";
import { ProbeLlmAdapter } from "../src/probe-adapter.ts";
import { runDshrboxBrowserProbe } from "../src/probe.ts";

test("composes DSH components and preserves raw streaming session events", async () => {
  const result = await runDshrboxBrowserProbe();

  assert.equal(result.ok, true);
  assert.equal(result.dsh_version, "0.1.0-rc.6");
  assert.equal(result.streaming.text, "DSH streams in a browser worker.");
  assert.equal(result.streaming.turn_end_kind, "completed");
  assert.ok(result.streaming.event_types.includes("assistant/chunk"));
  assert.ok(result.streaming.event_types.includes("assistant/message"));
  assert.equal(result.cancellation.text, "partial");
  assert.equal(result.cancellation.turn_end_kind, "aborted");
});

test("declares the constrained browser async-context contract", () => {
  assert.deepEqual(DSH_BROWSER_COMPATIBILITY, {
    async_context: "single_foreground_chain",
    max_live_agents: 1,
    max_parallel_tool_calls: 1,
  });
});

test("refuses an overlapping foreground turn", async () => {
  const adapter = new ProbeLlmAdapter({
    kind: "wait_for_cancel",
    partial_text: "partial",
  });
  const core = await createDshrboxCore({
    llm_adapter: adapter,
    model: "fake-streaming-model",
    provider: "dshrbox-overlap-probe",
    session_id: "dshrbox-overlap-probe",
  });
  try {
    const activeRun = core.runtime.run("First turn.");
    await adapter.waitUntilBlocked();
    await assert.rejects(
      core.runtime.run("Overlapping turn."),
      /single_foreground_chain/u,
    );
    core.runtime.cancel();
    await activeRun;
  } finally {
    await core.dispose();
  }
});
