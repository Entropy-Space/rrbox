import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWebCoreWorkerInitializeMessage,
  WEB_CORE_WORKER_PROTOCOL_VERSION,
} from "../browser/core-worker-initialization.ts";

test("validates exact web core plugin initialization", () => {
  const initialization = {
    protocol_version: WEB_CORE_WORKER_PROTOCOL_VERSION,
    kind: "web_core_initialize",
    python_plugin: {
      enabled: true,
      timeout_ms: 12_000,
      max_output_bytes: 64 * 1024,
    },
    web_search_plugin: {
      enabled: true,
      provider: "auto",
      routing_order: "exa-anysearch",
      workflow: "auto-summary",
      timeout_ms: 20_000,
      summary_timeout_ms: 30_000,
      review_timeout_ms: 20_000,
      maximum_results: 5,
      max_output_bytes: 64 * 1024,
    },
  };
  assert.equal(WEB_CORE_WORKER_PROTOCOL_VERSION, 5);
  assert.deepEqual(
    parseWebCoreWorkerInitializeMessage(initialization),
    initialization,
  );
  assert.throws(
    () =>
      parseWebCoreWorkerInitializeMessage({
        ...initialization,
        extra: true,
      }),
    /Invalid web core worker initialization/u,
  );
});
