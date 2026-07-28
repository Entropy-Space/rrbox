import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_OPENAI_PROVIDER_ID,
  NATIVE_PROVIDER_MODELS_URL,
  NATIVE_PROVIDER_PROTOCOL_VERSION,
  NativeOpenAiCompatibleModelTransport,
  NativeProviderBodyEventSequenceValidator,
  NativeProviderProtocolError,
  NativeProviderRpcClient,
  parseNativeProviderBodyEvent,
  parseNativeProviderFetchRequest,
} from "@researchbox/provider-native";

test("validates exact fixed-endpoint fetch requests", () => {
  const request = {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    request_id: "request-1",
    operation_id: "operation-1",
    provider_id: NATIVE_OPENAI_PROVIDER_ID,
    endpoint: "models",
    method: "get",
  };
  assert.deepEqual(parseNativeProviderFetchRequest(request), request);
  assert.throws(
    () =>
      parseNativeProviderFetchRequest({
        ...request,
        endpoint_url: "https://attacker.invalid",
      }),
    /Unknown native provider field: endpoint_url/u,
  );
  assert.throws(
    () =>
      parseNativeProviderFetchRequest({
        ...request,
        endpoint: "chat_completions",
      }),
    /requires POST with a body/u,
  );
});

test("enforces ordered response, chunk, and terminal events", () => {
  const validator = new NativeProviderBodyEventSequenceValidator();
  const responseStarted = providerEvent("operation-1", 0, {
    kind: "response_started",
    status: 200,
    status_text: "OK",
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(validator.accept(responseStarted), responseStarted);
  validator.accept(
    providerEvent("operation-1", 1, {
      kind: "body_chunk",
      chunk_base64: "e30=",
    }),
  );
  validator.accept(
    providerEvent("operation-1", 2, {
      kind: "body_finished",
      status: "complete",
    }),
  );
  assert.equal(validator.is_finished, true);
  assert.throws(
    () => validator.accept(responseStarted),
    /after completion/u,
  );

  assert.throws(
    () =>
      new NativeProviderBodyEventSequenceValidator().accept(
        providerEvent("operation-2", 1, {
          kind: "body_chunk",
          chunk_base64: "e30=",
        }),
      ),
    /Expected native provider event_index 0/u,
  );
});

test("rejects malformed base64 and non-lowercase response headers", () => {
  assert.throws(
    () =>
      parseNativeProviderBodyEvent(
        providerEvent("operation-1", 0, {
          kind: "body_chunk",
          chunk_base64: "not base64",
        }),
      ),
    /canonical base64/u,
  );
  assert.throws(
    () =>
      parseNativeProviderBodyEvent(
        providerEvent("operation-1", 0, {
          kind: "response_started",
          status: 200,
          status_text: "OK",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    /must be lowercase/u,
  );
});

test("discovers models through the constrained native fetch adapter", async () => {
  const channel = new MessageChannel();
  const ids = idFactory([
    "models-operation",
    "models-request",
  ]);
  const client = new NativeProviderRpcClient(channel.port2, {
    create_operation_id: ids,
    create_request_id: ids,
  });
  const transport = new NativeOpenAiCompatibleModelTransport(client);
  const requestPromise = nextPortMessage(channel.port1);
  const modelsPromise = transport.listModels(new AbortController().signal);
  const request = await requestPromise;

  assert.deepEqual(request, {
    protocol_version: 1,
    request_id: "models-request",
    operation_id: "models-operation",
    provider_id: "local-openai",
    endpoint: "models",
    method: "get",
  });

  channel.port1.postMessage(
    providerEvent(request.operation_id, 0, {
      kind: "response_started",
      status: 200,
      status_text: "OK",
      headers: { "content-type": "application/json" },
    }),
  );
  channel.port1.postMessage({
    protocol_version: 1,
    request_id: request.request_id,
    result: {
      kind: "fetch_started",
      operation_id: request.operation_id,
    },
  });
  channel.port1.postMessage(
    providerEvent(request.operation_id, 1, {
      kind: "body_chunk",
      chunk_base64: encodeBase64(
        JSON.stringify({
          data: [
            {
              id: "gpt-test",
              x_tokn_router: { limit: { context: 8192 } },
            },
          ],
        }),
      ),
    }),
  );
  channel.port1.postMessage(
    providerEvent(request.operation_id, 2, {
      kind: "body_finished",
      status: "complete",
    }),
  );

  assert.deepEqual(await modelsPromise, [
    {
      provider_id: "local-openai",
      provider_display_name:
        "OpenAI-compatible · localhost:4141",
      model_id: "gpt-test",
      display_name: "gpt-test",
      context_window: 8192,
      max_output_tokens: null,
      supports_tools: true,
      supports_reasoning: false,
      supports_reasoning_effort: false,
    },
  ]);

  client.close();
  channel.port1.close();
});

test("preserves incremental SSE ordering through the native body stream", async () => {
  const channel = new MessageChannel();
  const ids = idFactory([
    "stream-operation",
    "stream-request",
  ]);
  const client = new NativeProviderRpcClient(channel.port2, {
    create_operation_id: ids,
    create_request_id: ids,
  });
  const transport = new NativeOpenAiCompatibleModelTransport(client);
  const requestPromise = nextPortMessage(channel.port1);
  const eventsPromise = collectEvents(
    transport.stream(modelRequest(), new AbortController().signal),
  );
  const request = await requestPromise;

  assert.equal(request.endpoint, "chat_completions");
  assert.equal(request.method, "post");
  assert.equal(JSON.parse(request.body).model, "gpt-test");

  channel.port1.postMessage({
    protocol_version: 1,
    request_id: request.request_id,
    result: {
      kind: "fetch_started",
      operation_id: request.operation_id,
    },
  });
  channel.port1.postMessage(
    providerEvent(request.operation_id, 0, {
      kind: "response_started",
      status: 200,
      status_text: "OK",
      headers: { "content-type": "text/event-stream" },
    }),
  );
  channel.port1.postMessage(
    providerEvent(request.operation_id, 1, {
      kind: "body_chunk",
      chunk_base64: encodeBase64(
        'data: {"choices":[{"index":0,"delta":{"content":"Hel',
      ),
    }),
  );
  channel.port1.postMessage(
    providerEvent(request.operation_id, 2, {
      kind: "body_chunk",
      chunk_base64: encodeBase64(
        'lo"}}]}\n\ndata: [DONE]\n\n',
      ),
    }),
  );
  channel.port1.postMessage(
    providerEvent(request.operation_id, 3, {
      kind: "body_finished",
      status: "complete",
    }),
  );

  assert.deepEqual(await eventsPromise, [
    { type: "text_start", content_index: 0 },
    {
      type: "text_delta",
      content_index: 0,
      text_delta: "Hello",
    },
    { type: "text_end", content_index: 0 },
    { type: "done", stop_reason: "stop" },
  ]);

  client.close();
  channel.port1.close();
});

test("defers cancellation until the native start acknowledgement", async () => {
  const channel = new MessageChannel();
  const ids = idFactory([
    "abort-operation",
    "fetch-request",
    "cancel-request",
  ]);
  const client = new NativeProviderRpcClient(channel.port2, {
    create_operation_id: ids,
    create_request_id: ids,
  });
  const controller = new AbortController();
  const fetchRequest = nextPortMessage(channel.port1);
  const response = client.fetch_request(NATIVE_PROVIDER_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: controller.signal,
  });
  const request = await fetchRequest;
  controller.abort();

  await assert.rejects(response, { name: "AbortError" });
  assert.equal(
    await noPortMessage(channel.port1),
    true,
    "cancel must wait for fetch_started",
  );

  const cancelRequest = nextPortMessage(channel.port1);
  channel.port1.postMessage({
    protocol_version: 1,
    request_id: request.request_id,
    result: {
      kind: "fetch_started",
      operation_id: request.operation_id,
    },
  });
  assert.deepEqual(await cancelRequest, {
    protocol_version: 1,
    request_id: "cancel-request",
    operation_id: request.operation_id,
  });

  client.close();
  channel.port1.close();
});

test("honors abort after a terminal body event but before start acknowledgement", async () => {
  const channel = new MessageChannel();
  const ids = idFactory([
    "terminal-operation",
    "terminal-request",
  ]);
  const client = new NativeProviderRpcClient(channel.port2, {
    create_operation_id: ids,
    create_request_id: ids,
  });
  const controller = new AbortController();
  const requestMessage = nextPortMessage(channel.port1);
  const response = client.fetch_request(NATIVE_PROVIDER_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: controller.signal,
  });
  const request = await requestMessage;

  channel.port1.postMessage(
    providerEvent(request.operation_id, 0, {
      kind: "response_started",
      status: 200,
      status_text: "OK",
      headers: { "content-type": "application/json" },
    }),
  );
  channel.port1.postMessage(
    providerEvent(request.operation_id, 1, {
      kind: "body_chunk",
      chunk_base64: encodeBase64('{"data":[]}'),
    }),
  );
  channel.port1.postMessage(
    providerEvent(request.operation_id, 2, {
      kind: "body_finished",
      status: "complete",
    }),
  );
  await nextTask();
  controller.abort();

  await assert.rejects(response, { name: "AbortError" });
  channel.port1.postMessage({
    protocol_version: 1,
    request_id: request.request_id,
    result: {
      kind: "fetch_started",
      operation_id: request.operation_id,
    },
  });
  assert.equal(
    await noPortMessage(channel.port1),
    true,
    "a completed native operation must not receive a late cancel",
  );

  client.close();
  channel.port1.close();
});

test("supports concurrent operations with out-of-order acknowledgements", async () => {
  const channel = new MessageChannel();
  const operationIds = idFactory(["operation-a", "operation-b"]);
  const requestIds = idFactory(["request-a", "request-b"]);
  const client = new NativeProviderRpcClient(channel.port2, {
    create_operation_id: operationIds,
    create_request_id: requestIds,
  });
  const firstMessage = nextPortMessage(channel.port1);
  const first = client.fetch_request(NATIVE_PROVIDER_MODELS_URL, {
    headers: { accept: "application/json" },
  });
  const firstRequest = await firstMessage;
  const secondMessage = nextPortMessage(channel.port1);
  const second = client.fetch_request(NATIVE_PROVIDER_MODELS_URL, {
    headers: { accept: "application/json" },
  });
  const secondRequest = await secondMessage;

  completeJsonFetch(channel.port1, secondRequest, '{"data":[]}');
  completeJsonFetch(channel.port1, firstRequest, '{"data":[]}');

  assert.deepEqual(await (await first).json(), { data: [] });
  assert.deepEqual(await (await second).json(), { data: [] });
  client.close();
  channel.port1.close();
});

test("treats a cancellation command failure as terminal for its operation", async () => {
  const channel = new MessageChannel();
  const ids = idFactory([
    "failed-cancel-operation",
    "fetch-request",
    "cancel-request",
    "next-operation",
    "next-request",
  ]);
  const client = new NativeProviderRpcClient(channel.port2, {
    create_operation_id: ids,
    create_request_id: ids,
  });
  const controller = new AbortController();
  const firstRequestMessage = nextPortMessage(channel.port1);
  const first = client.fetch_request(NATIVE_PROVIDER_MODELS_URL, {
    headers: { accept: "application/json" },
    signal: controller.signal,
  });
  const firstRequest = await firstRequestMessage;
  channel.port1.postMessage({
    protocol_version: 1,
    request_id: firstRequest.request_id,
    result: {
      kind: "fetch_started",
      operation_id: firstRequest.operation_id,
    },
  });
  channel.port1.postMessage(
    providerEvent(firstRequest.operation_id, 0, {
      kind: "response_started",
      status: 200,
      status_text: "OK",
      headers: { "content-type": "application/json" },
    }),
  );
  await first;

  const cancelMessage = nextPortMessage(channel.port1);
  controller.abort();
  const cancelRequest = await cancelMessage;
  channel.port1.postMessage({
    protocol_version: 1,
    request_id: cancelRequest.request_id,
    result: {
      kind: "error",
      error: {
        code: "internal",
        message: "cancel failed",
      },
    },
  });

  const nextRequestMessage = nextPortMessage(channel.port1);
  const next = client.fetch_request(NATIVE_PROVIDER_MODELS_URL, {
    headers: { accept: "application/json" },
  });
  const nextRequest = await nextRequestMessage;
  completeJsonFetch(channel.port1, nextRequest, '{"data":[]}');
  assert.deepEqual(await (await next).json(), { data: [] });

  client.close();
  channel.port1.close();
});

test("fails all pending fetches on malformed correlation or close", async () => {
  const channel = new MessageChannel();
  const client = new NativeProviderRpcClient(channel.port2, {
    create_operation_id: () => "operation-1",
    create_request_id: () => "request-1",
  });
  const requestMessage = nextPortMessage(channel.port1);
  const response = client.fetch_request(NATIVE_PROVIDER_MODELS_URL, {
    headers: { accept: "application/json" },
  });
  await requestMessage;
  channel.port1.postMessage({
    protocol_version: 1,
    request_id: "wrong-request",
    result: {
      kind: "fetch_started",
      operation_id: "operation-1",
    },
  });
  await assert.rejects(
    response,
    (error) =>
      error instanceof NativeProviderProtocolError &&
      /unknown request_id/u.test(error.message),
  );

  const closeChannel = new MessageChannel();
  const closeClient = new NativeProviderRpcClient(closeChannel.port2, {
    create_operation_id: () => "close-operation",
    create_request_id: () => "close-request",
  });
  const closeRequestMessage = nextPortMessage(closeChannel.port1);
  const closeResponse = closeClient.fetch_request(
    NATIVE_PROVIDER_MODELS_URL,
    { headers: { accept: "application/json" } },
  );
  await closeRequestMessage;
  closeClient.close();
  await assert.rejects(closeResponse, /connection was closed/u);

  channel.port1.close();
  closeChannel.port1.close();
});

test("does not forward arbitrary URLs or credential headers", async () => {
  const channel = new MessageChannel();
  const client = new NativeProviderRpcClient(channel.port2);
  await assert.rejects(
    client.fetch_request("https://example.com/v1/models", {
      headers: { accept: "application/json" },
    }),
    /Unsupported native provider URL/u,
  );
  await assert.rejects(
    client.fetch_request(NATIVE_PROVIDER_MODELS_URL, {
      headers: {
        accept: "application/json",
        authorization: "Bearer secret",
      },
    }),
    /header is not supported: authorization/u,
  );
  assert.equal(await noPortMessage(channel.port1), true);
  client.close();
  channel.port1.close();
});

function providerEvent(operationId, eventIndex, event) {
  return {
    protocol_version: 1,
    operation_id: operationId,
    event_index: eventIndex,
    ...event,
  };
}

function completeJsonFetch(port, request, body) {
  port.postMessage({
    protocol_version: 1,
    request_id: request.request_id,
    result: {
      kind: "fetch_started",
      operation_id: request.operation_id,
    },
  });
  port.postMessage(
    providerEvent(request.operation_id, 0, {
      kind: "response_started",
      status: 200,
      status_text: "OK",
      headers: { "content-type": "application/json" },
    }),
  );
  port.postMessage(
    providerEvent(request.operation_id, 1, {
      kind: "body_chunk",
      chunk_base64: encodeBase64(body),
    }),
  );
  port.postMessage(
    providerEvent(request.operation_id, 2, {
      kind: "body_finished",
      status: "complete",
    }),
  );
}

function modelRequest() {
  return {
    session_id: "session-1",
    provider_id: "local-openai",
    model_id: "gpt-test",
    system_prompt: "Be concise.",
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  };
}

async function collectEvents(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function encodeBase64(value) {
  return Buffer.from(value).toString("base64");
}

function idFactory(values) {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("Test exhausted its deterministic ids.");
    }
    return value;
  };
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

function noPortMessage(port) {
  port.start();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      port.removeEventListener("message", onMessage);
      resolve(true);
    }, 20);
    const onMessage = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    port.addEventListener("message", onMessage, { once: true });
  });
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
