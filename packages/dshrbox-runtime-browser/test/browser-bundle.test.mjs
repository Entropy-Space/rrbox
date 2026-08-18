import assert from "node:assert/strict";
import test from "node:test";
import { runDshrboxBrowserProbe } from "../dist/browser-probe/worker.js";

test("executes the browser-worker bundle with DSH Node imports replaced", async () => {
  const result = await runDshrboxBrowserProbe();

  assert.equal(result.ok, true);
  assert.equal(result.streaming.turn_end_kind, "completed");
  assert.equal(result.cancellation.turn_end_kind, "aborted");
  assert.equal(result.workspace.tool_name, "read_file");
  assert.equal(result.workspace.result_text, "Browser workspace content.");
  assert.equal(result.workspace.model_observed_result, true);
  assert.equal(result.workspace.turn_end_kind, "completed");
});
