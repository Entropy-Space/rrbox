import assert from "node:assert/strict";
import test from "node:test";
import { handleMockModelRequest } from "@researchbox/mock-provider";
import { WorkerModelTransport } from "@researchbox/runtime-browser";
import {
  attachNativeMockLlmWorker,
  IN_PROCESS_MOCK_MODEL_ENDPOINT,
  nativeMockModel,
} from "../src/runtime/native-mock-llm.ts";

test("streams the mock model in-process and exposes its catalog", async () => {
  const { host, worker } = createWorkerPair();
  let handledRequest;
  const attachment = attachNativeMockLlmWorker(host, async (request) => {
    handledRequest = request;
    return handleMockModelRequest(request);
  });
  const transport = new WorkerModelTransport(worker);

  assert.deepEqual(
    await transport.listModels(
      nativeMockModel.provider_id,
      new AbortController().signal,
    ),
    [nativeMockModel],
  );

  const events = await collect(
    transport.stream(
      createModelRequest("Inspect the workspace"),
      new AbortController().signal,
    ),
  );

  assert.equal(handledRequest?.url, IN_PROCESS_MOCK_MODEL_ENDPOINT);
  assert.equal(handledRequest?.method, "POST");
  assert.equal(
    handledRequest?.headers.get("content-type"),
    "application/json",
  );
  assert.deepEqual(
    events
      .filter((event) => !event.type.endsWith("_delta"))
      .map((event) => event.type),
    [
      "reasoning_start",
      "reasoning_end",
      "text_start",
      "text_end",
      "tool_call_start",
      "tool_call_end",
      "done",
    ],
  );
  assert.equal(events.at(-1)?.stop_reason, "tool_use");

  transport.close();
  attachment.close();
});

test("aborting a native model stream cancels the in-process response", async () => {
  const { host, worker, hostEvents } = createWorkerPair();
  let observeRequestAbort;
  const requestAborted = new Promise((resolve) => {
    observeRequestAbort = resolve;
  });
  const attachment = attachNativeMockLlmWorker(host, async (request) => {
    request.signal.addEventListener("abort", observeRequestAbort, {
      once: true,
    });
    return handleMockModelRequest(request);
  });
  const transport = new WorkerModelTransport(worker);
  const controller = new AbortController();
  const iterator = transport
    .stream(createModelRequest("Inspect the workspace"), controller.signal)
    [Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "reasoning_start", content_index: 0 },
  });
  controller.abort();

  await assert.rejects(iterator.next(), { name: "AbortError" });
  await requestAborted;
  assert.equal(
    hostEvents.filter(
      (event) =>
        event.type === "stream_finished" &&
        event.payload.status === "aborted",
    ).length,
    1,
  );

  transport.close();
  attachment.close();
});

function createModelRequest(prompt) {
  return {
    session_id: "native-session",
    provider_id: nativeMockModel.provider_id,
    model_id: nativeMockModel.model_id,
    system_prompt: "Help with the workspace.",
    messages: [{ role: "user", content: prompt }],
    tools: [
      {
        name: "list_files",
        description: "List files in the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function createWorkerPair() {
  const listeners = new Map([
    ["message", new Set()],
    ["error", new Set()],
    ["messageerror", new Set()],
  ]);
  const hostEvents = [];
  const host = {
    onmessage: null,
    postMessage(event) {
      hostEvents.push(event);
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
  return { host, worker, hostEvents };
}
