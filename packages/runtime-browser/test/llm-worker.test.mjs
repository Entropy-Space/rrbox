import assert from "node:assert/strict";
import test from "node:test";
import { LLM_WORKER_PROTOCOL_VERSION } from "@researchbox/model-transport";
import {
  attachLlmWorkerHost,
  WorkerModelTransport,
} from "../src/index.ts";

const request = (prompt) => ({
  session_id: `session-${prompt}`,
  provider_id: "researchbox",
  model_id: "researchbox-mock",
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
});

test("multiplexes LLM worker streams without cross-talk", async () => {
  const { host, worker } = createWorkerPair();
  attachLlmWorkerHost(host, {
    async *stream(modelRequest) {
      const prompt = promptFromRequest(modelRequest);
      yield { type: "text_delta", text_delta: `${prompt}:one` };
      await Promise.resolve();
      yield { type: "text_delta", text_delta: `${prompt}:two` };
      yield { type: "done" };
    },
  });
  const transport = new WorkerModelTransport(worker);

  const [alpha, beta] = await Promise.all([
    collect(transport, request("alpha")),
    collect(transport, request("beta")),
  ]);

  assert.deepEqual(alpha, [
    { type: "text_delta", text_delta: "alpha:one" },
    { type: "text_delta", text_delta: "alpha:two" },
    { type: "done" },
  ]);
  assert.deepEqual(beta, [
    { type: "text_delta", text_delta: "beta:one" },
    { type: "text_delta", text_delta: "beta:two" },
    { type: "done" },
  ]);
  transport.close();
});

test("correlates model discovery results by request and provider", async () => {
  const { worker, emitMessage, commands } = createDetachedWorker();
  const transport = new WorkerModelTransport(worker);
  const signal = new AbortController().signal;
  const alpha = transport.listModels("provider-alpha", signal);
  const beta = transport.listModels("provider-beta", signal);
  await Promise.resolve();

  const alphaRequest = commands.find(
    (command) =>
      command.type === "models_request" &&
      command.payload.provider_id === "provider-alpha",
  );
  const betaRequest = commands.find(
    (command) =>
      command.type === "models_request" &&
      command.payload.provider_id === "provider-beta",
  );
  assert.ok(alphaRequest?.request_id);
  assert.ok(betaRequest?.request_id);

  const alphaModel = descriptor("provider-alpha", "alpha-model");
  const betaModel = descriptor("provider-beta", "beta-model");
  emitModelsResult(emitMessage, betaRequest.request_id, betaModel, "event-beta");
  emitModelsResult(
    emitMessage,
    alphaRequest.request_id,
    alphaModel,
    "event-alpha",
  );

  assert.deepEqual(await alpha, [alphaModel]);
  assert.deepEqual(await beta, [betaModel]);
  transport.close();
});

test("aborts model discovery in the LLM worker", async () => {
  const { host, worker, commands } = createWorkerPair();
  let observeAbort;
  const abortObserved = new Promise((resolve) => {
    observeAbort = resolve;
  });
  attachLlmWorkerHost(
    host,
    {
      async *stream() {
        yield { type: "done" };
      },
    },
    {
      async listModels(_providerId, signal) {
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        observeAbort();
        throw signal.reason;
      },
    },
  );
  const transport = new WorkerModelTransport(worker);
  const controller = new AbortController();
  const pending = transport.listModels("provider-alpha", controller.signal);
  await Promise.resolve();
  controller.abort();

  await assert.rejects(pending, { name: "AbortError" });
  await abortObserved;
  const request = commands.find(
    (command) => command.type === "models_request",
  );
  assert.ok(request?.request_id);
  assert.equal(
    commands.filter(
      (command) =>
        command.type === "models_abort" &&
        command.request_id === request.request_id,
    ).length,
    1,
  );
  transport.close();
});

test("translates AbortSignal into one correlated abort command", async () => {
  const { host, worker, commands } = createWorkerPair();
  let observeAbort;
  const abortObserved = new Promise((resolve) => {
    observeAbort = resolve;
  });
  attachLlmWorkerHost(host, {
    async *stream(_modelRequest, signal) {
      yield { type: "text_delta", text_delta: "started" };
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", resolve, { once: true });
      });
      observeAbort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  const transport = new WorkerModelTransport(worker);
  const controller = new AbortController();
  const iterator = transport
    .stream(request("cancel"), controller.signal)
    [Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", text_delta: "started" },
  });
  controller.abort();
  await assert.rejects(iterator.next(), { name: "AbortError" });
  await abortObserved;

  assert.equal(
    commands.filter((command) => command.type === "stream_abort").length,
    1,
  );
  transport.close();
});

test("does not yield buffered events after cancellation", async () => {
  const { worker, emitMessage, commands } = createDetachedWorker();
  const transport = new WorkerModelTransport(worker);
  const controller = new AbortController();
  const iterator = transport
    .stream(request("buffered"), controller.signal)
    [Symbol.asyncIterator]();
  const first = iterator.next();
  await Promise.resolve();
  const streamId = commands[0]?.stream_id;
  assert.ok(streamId);

  emitModelEvent(emitMessage, streamId, "event-1", {
    type: "text_delta",
    text_delta: "first",
  });
  emitModelEvent(emitMessage, streamId, "event-2", {
    type: "text_delta",
    text_delta: "must-not-render",
  });
  await first;
  controller.abort();

  await assert.rejects(iterator.next(), { name: "AbortError" });
  transport.close();
});

test("rejects a remote transport that ends without done", async () => {
  const { host, worker } = createWorkerPair();
  attachLlmWorkerHost(host, {
    async *stream() {
      yield { type: "text_delta", text_delta: "partial" };
    },
  });
  const transport = new WorkerModelTransport(worker);

  await assert.rejects(
    collect(transport, request("truncated")),
    /ended before a done event/,
  );
  transport.close();
});

test("aborts unfinished work when a consumer stops iterating", async () => {
  const { worker, emitMessage, commands } = createDetachedWorker();
  const transport = new WorkerModelTransport(worker);
  const iterator = transport
    .stream(request("early-return"), new AbortController().signal)
    [Symbol.asyncIterator]();
  const next = iterator.next();
  await Promise.resolve();
  const streamId = commands[0]?.stream_id;
  assert.ok(streamId);

  emitMessage({
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: "event-1",
    stream_id: streamId,
    type: "stream_event",
    payload: {
      model_event: { type: "text_delta", text_delta: "first" },
    },
  });
  await next;
  await iterator.return();

  assert.equal(
    commands.filter((command) => command.type === "stream_abort").length,
    1,
  );
  transport.close();
});

test("rejects all pending requests when the LLM worker crashes", async () => {
  const { worker, emitError, wasErrorPrevented } = createDetachedWorker();
  const transport = new WorkerModelTransport(worker);
  const fatalErrors = [];
  transport.subscribeFatalError((error) => fatalErrors.push(error.message));
  const alpha = collect(transport, request("alpha"));
  const beta = collect(transport, request("beta"));
  await Promise.resolve();

  emitError("worker crashed");
  assert.equal(wasErrorPrevented(), true);

  await assert.rejects(alpha, /worker crashed/);
  await assert.rejects(beta, /worker crashed/);
  await assert.rejects(
    collect(transport, request("future")),
    /worker crashed/,
  );
  assert.deepEqual(fatalErrors, ["worker crashed"]);

  const replayedFatalErrors = [];
  transport.subscribeFatalError((error) =>
    replayedFatalErrors.push(error.message),
  );
  assert.deepEqual(replayedFatalErrors, ["worker crashed"]);
  transport.close();
});

test("isolates a malformed correlated event to its stream", async () => {
  const { worker, emitMessage, commands } = createDetachedWorker();
  const transport = new WorkerModelTransport(worker);
  const alpha = collect(transport, request("alpha"));
  const beta = collect(transport, request("beta"));
  await Promise.resolve();
  const alphaId = commands.find(
    (command) =>
      promptFromRequest(command.payload?.model_request) === "alpha",
  )?.stream_id;
  const betaId = commands.find(
    (command) => promptFromRequest(command.payload?.model_request) === "beta",
  )?.stream_id;
  assert.ok(alphaId);
  assert.ok(betaId);

  emitMessage({
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: "event-invalid",
    stream_id: alphaId,
    type: "stream_event",
    payload: { model_event: { type: "unknown" } },
  });
  emitModelEvent(emitMessage, betaId, "event-done", { type: "done" });
  emitMessage({
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: "event-finished",
    stream_id: betaId,
    type: "stream_finished",
    payload: { status: "complete" },
  });

  await assert.rejects(alpha, /Invalid LLM worker event/);
  assert.deepEqual(await beta, [{ type: "done" }]);
  transport.close();
});

test("rejects pending work on an unreadable worker message", async () => {
  const { worker, emitMessageError } = createDetachedWorker();
  const transport = new WorkerModelTransport(worker);
  const pending = collect(transport, request("message-error"));
  await Promise.resolve();

  emitMessageError();

  await assert.rejects(pending, /unreadable message/);
  transport.close();
});

async function collect(transport, modelRequest) {
  const events = [];
  for await (const event of transport.stream(
    modelRequest,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

function createWorkerPair() {
  const detached = createDetachedWorker();
  const host = {
    onmessage: null,
    postMessage(event) {
      queueMicrotask(() => detached.emitMessage(structuredClone(event)));
    },
  };
  detached.forwardCommand((command) => {
    queueMicrotask(() => {
      host.onmessage?.(
        new MessageEvent("message", { data: structuredClone(command) }),
      );
    });
  });
  return { host, ...detached };
}

function createDetachedWorker() {
  const listeners = new Map([
    ["message", new Set()],
    ["error", new Set()],
    ["messageerror", new Set()],
  ]);
  const commands = [];
  let errorPrevented = false;
  let commandListener = () => {};
  const worker = {
    addEventListener(type, listener) {
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(command) {
      const cloned = structuredClone(command);
      commands.push(cloned);
      commandListener(cloned);
    },
    terminate() {},
  };

  return {
    worker,
    commands,
    emitMessage(data) {
      for (const listener of listeners.get("message") ?? []) {
        listener(new MessageEvent("message", { data }));
      }
    },
    emitError(message) {
      for (const listener of listeners.get("error") ?? []) {
        listener({
          message,
          preventDefault() {
            errorPrevented = true;
          },
        });
      }
    },
    emitMessageError() {
      for (const listener of listeners.get("messageerror") ?? []) {
        listener(new MessageEvent("messageerror"));
      }
    },
    wasErrorPrevented() {
      return errorPrevented;
    },
    forwardCommand(listener) {
      commandListener = listener;
    },
  };
}

function emitModelEvent(emitMessage, streamId, eventId, modelEvent) {
  emitMessage({
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: eventId,
    stream_id: streamId,
    type: "stream_event",
    payload: { model_event: modelEvent },
  });
}

function emitModelsResult(emitMessage, requestId, model, eventId) {
  emitMessage({
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: eventId,
    request_id: requestId,
    type: "models_result",
    payload: {
      provider_id: model.provider_id,
      models: [model],
    },
  });
}

function descriptor(providerId, modelId) {
  return {
    provider_id: providerId,
    provider_display_name: providerId,
    model_id: modelId,
    display_name: modelId,
    context_window: 32_000,
    max_output_tokens: 4_096,
    supports_tools: true,
    supports_reasoning: false,
  };
}

function promptFromRequest(modelRequest) {
  return modelRequest?.messages
    ?.findLast((message) => message.role === "user")
    ?.content;
}
