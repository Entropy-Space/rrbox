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
  const coreInitialization = {
    protocol_version: NATIVE_CORE_WORKER_PROTOCOL_VERSION,
    kind: "native_core_initialize",
    storage_port: storageChannel.port1,
    provider_port: providerChannel.port1,
  };

  assert.equal(NATIVE_CORE_WORKER_PROTOCOL_VERSION, 2);
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
});
