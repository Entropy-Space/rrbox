import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runDshrboxBrowserProbe } from "../dist/browser-probe/worker.js";

test("installs disposal symbols before evaluating DSH classes", async () => {
  const source = await readFile(
    new URL("../dist/browser-probe/worker.js", import.meta.url),
    "utf8",
  );
  const installation = source.indexOf("installDisposableSymbols();");
  const firstComputedMethod = source.indexOf("[Symbol.dispose]");

  assert.notEqual(installation, -1);
  assert.notEqual(firstComputedMethod, -1);
  assert.ok(installation < firstComputedMethod);
});

test("executes the browser-worker bundle with DSH Node imports replaced", async () => {
  const result = await runDshrboxBrowserProbe();

  assert.equal(result.ok, true);
  assert.equal(result.streaming.turn_end_kind, "completed");
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
  assert.equal(result.session_runtime.runtime_id, "dsh");
  assert.ok(result.session_runtime.persisted_event_count > 0);
  assert.deepEqual(result.session_runtime.timeline_types, [
    "user_message",
    "assistant_message",
    "tool_result",
    "assistant_message",
  ]);
});

test("accepts JavaScriptCore native constructor source formatting", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    Function.prototype,
    "toString",
  );
  assert.ok(descriptor);
  const nativeToString = descriptor.value;
  assert.equal(typeof nativeToString, "function");

  Object.defineProperty(Function.prototype, "toString", {
    ...descriptor,
    value() {
      const source = Reflect.apply(nativeToString, this, []);
      if (this !== Object && this !== Array) return source;
      return source.replace(
        "{ [native code] }",
        "{\n    [native code]\n}",
      );
    },
  });

  try {
    const result = await runDshrboxBrowserProbe();
    assert.equal(result.ok, true);
    assert.equal(result.workspace.tool_name, "read_file");
    assert.equal(result.session_runtime.runtime_id, "dsh");
  } finally {
    Object.defineProperty(Function.prototype, "toString", descriptor);
  }
});
