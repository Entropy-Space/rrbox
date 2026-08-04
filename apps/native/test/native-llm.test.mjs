import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_PROVIDER_PROTOCOL_VERSION,
} from "@researchbox/provider-native";
import { WorkerModelTransport } from "@researchbox/runtime-browser";
import { attachNativeLlmWorker } from "../src/runtime/native-llm.ts";
import { nativeMockModel } from "../src/runtime/native-mock-llm.ts";

test("keeps the mock catalog available when the native provider fails", async () => {
  const { host, worker } = createWorkerPair();
  const providerChannel = new MessageChannel();
  const attachment = attachNativeLlmWorker(
    host,
    providerChannel.port2,
    [localProviderConfiguration()],
  );
  const transport = new WorkerModelTransport(worker);
  const providerRequest = nextPortMessage(providerChannel.port1);
  const localModels = transport.listModels(
    "local-openai",
    new AbortController().signal,
  );
  const request = await providerRequest;

  providerChannel.port1.postMessage({
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    request_id: request.request_id,
    result: {
      kind: "fetch_started",
      operation_id: request.operation_id,
    },
  });
  providerChannel.port1.postMessage({
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    operation_id: request.operation_id,
    event_index: 0,
    kind: "body_finished",
    status: "error",
    error_message: "The local OpenAI provider is unavailable.",
  });

  await assert.rejects(localModels, /provider is unavailable/u);
  assert.deepEqual(
    await transport.listModels(
      nativeMockModel.provider_id,
      new AbortController().signal,
    ),
    [nativeMockModel],
  );

  transport.close();
  attachment.close();
  providerChannel.port1.close();
});

function createWorkerPair() {
  const listeners = new Map([
    ["message", new Set()],
    ["error", new Set()],
    ["messageerror", new Set()],
  ]);
  const host = {
    onmessage: null,
    postMessage(event) {
      queueMicrotask(() => {
        for (const listener of listeners.get("message") ?? []) {
          listener({ data: event });
        }
      });
    },
  };
  const worker = {
    addEventListener(type, listener) {
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(command) {
      queueMicrotask(() => host.onmessage?.({ data: command }));
    },
    terminate() {},
  };
  return { host, worker };
}

function nextPortMessage(port) {
  port.start();
  return new Promise((resolve) => {
    port.addEventListener(
      "message",
      (event) => resolve(event.data),
      { once: true },
    );
  });
}

function localProviderConfiguration() {
  return {
    provider_id: "local-openai",
    display_name: "OpenAI-compatible · localhost:4141",
    preset_id: "local",
    base_url: "http://127.0.0.1:4141/v1",
    enabled: true,
    manual_models: [],
    send_reasoning_content: true,
    send_session_affinity_headers: true,
  };
}
