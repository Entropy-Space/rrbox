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
  const webSearchChannel = new MessageChannel();
  const urlReaderChannel = new MessageChannel();
  const coreInitialization = {
    protocol_version: NATIVE_CORE_WORKER_PROTOCOL_VERSION,
    kind: "native_core_initialize",
    providers: [providerConfiguration()],
    storage_port: storageChannel.port1,
    provider_port: providerChannel.port1,
    python_port: pythonChannel.port1,
    web_search_port: webSearchChannel.port1,
    url_reader_port: urlReaderChannel.port1,
    python_plugin: {
      enabled: true,
      timeout_ms: 15_000,
      max_output_bytes: 1024,
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

  assert.equal(NATIVE_CORE_WORKER_PROTOCOL_VERSION, 10);
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
    providers: [providerConfiguration()],
  };
  assert.equal(NATIVE_LLM_WORKER_PROTOCOL_VERSION, 2);
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
  webSearchChannel.port1.close();
  webSearchChannel.port2.close();
  urlReaderChannel.port1.close();
  urlReaderChannel.port2.close();
});

function providerConfiguration() {
  return {
    provider_id: "provider-1",
    display_name: "Provider",
    preset_id: "custom",
    base_url: "https://example.com/v1",
    enabled: true,
    manual_models: [],
    send_reasoning_content: false,
    send_session_affinity_headers: false,
  };
}
