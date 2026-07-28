import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_CORE_WORKER_PROTOCOL_VERSION,
  NATIVE_LLM_WORKER_PROTOCOL_VERSION,
  parseNativeCoreWorkerInitializeMessage,
  parseNativeLlmWorkerInitializeMessage,
} from "../src/lib/types.ts";

test("uses distinct strict versions for core and LLM worker initialization", () => {
  const storageChannel = new MessageChannel();
  const providerChannel = new MessageChannel();
  const pythonChannel = new MessageChannel();
  const coreInitialization = {
    protocol_version: NATIVE_CORE_WORKER_PROTOCOL_VERSION,
    kind: "native_core_initialize",
    storage_port: storageChannel.port1,
    provider_port: providerChannel.port1,
    python_port: pythonChannel.port1,
    python_plugin: {
      enabled: true,
      timeout_ms: 15_000,
      max_output_bytes: 1024,
    },
    web_search_plugin: {
      enabled: true,
      provider: "auto",
      workflow: "auto-summary",
      timeout_ms: 20_000,
      summary_timeout_ms: 30_000,
      maximum_results: 5,
      max_output_bytes: 64 * 1024,
    },
  };

  assert.equal(NATIVE_CORE_WORKER_PROTOCOL_VERSION, 6);
  assert.deepEqual(
    parseNativeCoreWorkerInitializeMessage(coreInitialization),
    coreInitialization,
  );
  assert.throws(
    () =>
      parseNativeCoreWorkerInitializeMessage({
        ...coreInitialization,
        protocol_version: 1,
      }),
    /Invalid native core worker initialization/u,
  );

  const llmInitialization = {
    protocol_version: NATIVE_LLM_WORKER_PROTOCOL_VERSION,
    kind: "native_llm_initialize",
    provider_port: providerChannel.port2,
  };
  assert.equal(NATIVE_LLM_WORKER_PROTOCOL_VERSION, 1);
  assert.deepEqual(
    parseNativeLlmWorkerInitializeMessage(llmInitialization),
    llmInitialization,
  );
  assert.throws(
    () =>
      parseNativeLlmWorkerInitializeMessage({
        ...llmInitialization,
        extra: true,
      }),
    /Invalid native LLM worker initialization/u,
  );

  storageChannel.port1.close();
  storageChannel.port2.close();
  providerChannel.port1.close();
  providerChannel.port2.close();
  pythonChannel.port1.close();
  pythonChannel.port2.close();
});
