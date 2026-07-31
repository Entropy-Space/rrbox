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
  messages: [
    { role: "user", content: "Inspect the workspace." },
    {
      role: "assistant",
      content_blocks: [
        { type: "reasoning", reasoning: "I should list the root." },
        { type: "text", text: "I will inspect it." },
        {
          type: "tool_call",
          tool_call_id: "prior-list",
          tool_name: "list_files",
          arguments: { path: "/" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "prior-list",
      tool_name: "list_files",
      content: "[]",
      is_error: false,
    },
    { role: "user", content: prompt },
  ],
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
      yield { type: "reasoning_start", content_index: 0 };
      yield {
        type: "reasoning_delta",
        content_index: 0,
        reasoning_delta: `${prompt}:thinking`,
      };
      yield { type: "reasoning_end", content_index: 0 };
      yield { type: "text_start", content_index: 1 };
      yield {
        type: "text_delta",
        content_index: 1,
        text_delta: `${prompt}:one`,
      };
      await Promise.resolve();
      yield {
        type: "text_delta",
        content_index: 1,
        text_delta: `${prompt}:two`,
      };
      yield { type: "text_end", content_index: 1 };
      yield { type: "done" };
    },
  });
  const transport = new WorkerModelTransport(worker);

  const [alpha, beta] = await Promise.all([
    collect(transport, request("alpha")),
    collect(transport, request("beta")),
  ]);

  assert.deepEqual(alpha, [
    { type: "reasoning_start", content_index: 0 },
    {
      type: "reasoning_delta",
      content_index: 0,
      reasoning_delta: "alpha:thinking",
    },
    { type: "reasoning_end", content_index: 0 },
    { type: "text_start", content_index: 1 },
    { type: "text_delta", content_index: 1, text_delta: "alpha:one" },
    { type: "text_delta", content_index: 1, text_delta: "alpha:two" },
    { type: "text_end", content_index: 1 },
    { type: "done" },
  ]);
  assert.deepEqual(beta, [
    { type: "reasoning_start", content_index: 0 },
    {
      type: "reasoning_delta",
      content_index: 0,
      reasoning_delta: "beta:thinking",
    },
    { type: "reasoning_end", content_index: 0 },
    { type: "text_start", content_index: 1 },
    { type: "text_delta", content_index: 1, text_delta: "beta:one" },
    { type: "text_delta", content_index: 1, text_delta: "beta:two" },
    { type: "text_end", content_index: 1 },
    { type: "done" },
  ]);
  transport.close();
});

test("round-trips search_files through the LLM worker boundary", async () => {
  const { host, worker } = createWorkerPair();
  const searchCall = {
    tool_call_id: "search-1",
    tool_name: "search_files",
    arguments: {
      path: "/src",
      query: "ModelToolName",
    },
  };
  const searchRequest = {
    ...request("find the model tool type"),
    tools: [
      {
        name: "search_files",
        description: "Search text files in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            query: { type: "string" },
          },
          required: ["path", "query"],
        },
      },
    ],
  };
  let receivedRequest;
  attachLlmWorkerHost(host, {
    async *stream(modelRequest) {
      receivedRequest = modelRequest;
      yield { type: "tool_call_start", content_index: 0 };
      yield {
        type: "tool_call_delta",
        content_index: 0,
        tool_call_id_delta: searchCall.tool_call_id,
        tool_name_delta: searchCall.tool_name,
        arguments_delta: JSON.stringify(searchCall.arguments),
      };
      yield {
        type: "tool_call_end",
        content_index: 0,
        tool_call: searchCall,
      };
      yield { type: "done", stop_reason: "tool_use" };
    },
  });
  const transport = new WorkerModelTransport(worker);

  const events = await collect(transport, searchRequest);

  assert.deepEqual(receivedRequest, searchRequest);
  assert.deepEqual(events, [
    { type: "tool_call_start", content_index: 0 },
    {
      type: "tool_call_delta",
      content_index: 0,
      tool_call_id_delta: "search-1",
      tool_name_delta: "search_files",
      arguments_delta: '{"path":"/src","query":"ModelToolName"}',
    },
    {
      type: "tool_call_end",
      content_index: 0,
      tool_call: searchCall,
    },
    { type: "done", stop_reason: "tool_use" },
  ]);
  transport.close();
});

test("round-trips remove_file through the LLM worker boundary", async () => {
  const { host, worker } = createWorkerPair();
  const removeCall = {
    tool_call_id: "remove-1",
    tool_name: "remove_file",
    arguments: { path: "/obsolete.md" },
  };
  const removeRequest = {
    ...request("remove the obsolete file"),
    tools: [
      {
        name: "remove_file",
        description: "Remove one workspace file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
  };
  let receivedRequest;
  attachLlmWorkerHost(host, {
    async *stream(modelRequest) {
      receivedRequest = modelRequest;
      yield { type: "tool_call_start", content_index: 0 };
      yield {
        type: "tool_call_delta",
        content_index: 0,
        tool_call_id_delta: removeCall.tool_call_id,
        tool_name_delta: removeCall.tool_name,
        arguments_delta: JSON.stringify(removeCall.arguments),
      };
      yield {
        type: "tool_call_end",
        content_index: 0,
        tool_call: removeCall,
      };
      yield { type: "done", stop_reason: "tool_use" };
    },
  });
  const transport = new WorkerModelTransport(worker);

  const events = await collect(transport, removeRequest);

  assert.deepEqual(receivedRequest, removeRequest);
  assert.deepEqual(events, [
    { type: "tool_call_start", content_index: 0 },
    {
      type: "tool_call_delta",
      content_index: 0,
      tool_call_id_delta: "remove-1",
      tool_name_delta: "remove_file",
      arguments_delta: '{"path":"/obsolete.md"}',
    },
    {
      type: "tool_call_end",
      content_index: 0,
      tool_call: removeCall,
    },
    { type: "done", stop_reason: "tool_use" },
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
      yield { type: "text_start", content_index: 0 };
      yield {
        type: "text_delta",
        content_index: 0,
        text_delta: "started",
      };
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
    value: { type: "text_start", content_index: 0 },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: "text_delta",
      content_index: 0,
      text_delta: "started",
    },
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
    type: "text_start",
    content_index: 0,
  });
  emitModelEvent(emitMessage, streamId, "event-2", {
    type: "text_delta",
    content_index: 0,
    text_delta: "first",
  });
  emitModelEvent(emitMessage, streamId, "event-3", {
    type: "text_delta",
    content_index: 0,
    text_delta: "must-not-render",
  });
  emitModelEvent(emitMessage, streamId, "event-4", {
    type: "text_end",
    content_index: 0,
  });
  emitModelEvent(emitMessage, streamId, "event-5", { type: "done" });
  await first;
  controller.abort();

  await assert.rejects(iterator.next(), { name: "AbortError" });
  transport.close();
});

test("rejects a remote transport that ends without done", async () => {
  const { host, worker } = createWorkerPair();
  attachLlmWorkerHost(host, {
    async *stream() {
      yield { type: "text_start", content_index: 0 };
      yield {
        type: "text_delta",
        content_index: 0,
        text_delta: "partial",
      };
      yield { type: "text_end", content_index: 0 };
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
      model_event: { type: "text_start", content_index: 0 },
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

test("ignores a malformed late event from a completed stream", async () => {
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

  emitModelEvent(emitMessage, alphaId, "alpha-done", { type: "done" });
  emitMessage({
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: "alpha-finished",
    stream_id: alphaId,
    type: "stream_finished",
    payload: { status: "complete" },
  });
  assert.deepEqual(await alpha, [{ type: "done" }]);

  emitMessage({
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: "alpha-late-invalid",
    stream_id: alphaId,
    type: "stream_event",
    payload: { model_event: { type: "unknown" } },
  });
  emitModelEvent(emitMessage, betaId, "beta-done", { type: "done" });
  emitMessage({
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: "beta-finished",
    stream_id: betaId,
    type: "stream_finished",
    payload: { status: "complete" },
  });

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
    supports_reasoning_effort: false,
    reasoning_efforts: [],
  };
}

function promptFromRequest(modelRequest) {
  return modelRequest?.messages
    ?.findLast((message) => message.role === "user")
    ?.content;
}
