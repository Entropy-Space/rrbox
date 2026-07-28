import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_PROVIDER_MODELS_URL,
  NATIVE_PROVIDER_PROTOCOL_VERSION,
  NativeProviderRpcClient,
} from "@researchbox/provider-native";
import {
  createNativeProviderPortBroker,
} from "../src/lib/native-provider-broker.ts";

test("relays fetch acknowledgements and ordered body events", async () => {
  const channel = new MessageChannel();
  const requests = [];
  const broker = createNativeProviderPortBroker(channel.port1, {
    async fetch(request, onEvent) {
      requests.push(request);
      onEvent(
        providerEvent(request.operation_id, 0, {
          kind: "response_started",
          status: 200,
          status_text: "OK",
          headers: { "content-type": "application/json" },
        }),
      );
      onEvent(
        providerEvent(request.operation_id, 1, {
          kind: "body_chunk",
          chunk_base64: "e30=",
        }),
      );
      onEvent(
        providerEvent(request.operation_id, 2, {
          kind: "body_finished",
          status: "complete",
        }),
      );
      return fetchStarted(request);
    },
    async cancel(request) {
      return cancelled(request, false);
    },
  });

  const messages = collectPortMessages(channel.port2, 4);
  channel.port2.postMessage(fetchRequest("request-1", "operation-1"));

  assert.deepEqual(await messages, [
    providerEvent("operation-1", 0, {
      kind: "response_started",
      status: 200,
      status_text: "OK",
      headers: { "content-type": "application/json" },
    }),
    providerEvent("operation-1", 1, {
      kind: "body_chunk",
      chunk_base64: "e30=",
    }),
    providerEvent("operation-1", 2, {
      kind: "body_finished",
      status: "complete",
    }),
    fetchStarted(fetchRequest("request-1", "operation-1")),
  ]);
  assert.deepEqual(requests, [
    fetchRequest("request-1", "operation-1"),
  ]);

  broker.close();
  channel.port2.close();
});

test("defers close cancellation until fetch start settles", async () => {
  const channel = new MessageChannel();
  const start = deferred();
  const fetchCalled = deferred();
  const cancelRequests = [];
  const broker = createNativeProviderPortBroker(channel.port1, {
    fetch() {
      fetchCalled.resolve();
      return start.promise;
    },
    async cancel(request) {
      cancelRequests.push(request);
      return cancelled(request, true);
    },
  });

  channel.port2.postMessage(fetchRequest("request-1", "operation-1"));
  await fetchCalled.promise;
  const closedMessage = nextPortMessage(channel.port2);
  broker.close();
  assert.deepEqual(await closedMessage, {
    protocol_version: 1,
    kind: "connection_error",
    error_message: "The native provider broker was closed.",
  });
  assert.deepEqual(cancelRequests, []);

  start.resolve(fetchStarted(fetchRequest("request-1", "operation-1")));
  await waitFor(() => cancelRequests.length === 1);
  assert.equal(cancelRequests.length, 1);
  assert.equal(cancelRequests[0].operation_id, "operation-1");
  assert.match(
    cancelRequests[0].request_id,
    /^broker-cancel-/u,
  );

  channel.port2.close();
});

test("isolates malformed channel events and cancels after start ack", async () => {
  const channel = new MessageChannel();
  const start = deferred();
  const fetchCalled = deferred();
  const cancelRequests = [];
  let sendEvent;
  const broker = createNativeProviderPortBroker(channel.port1, {
    fetch(_request, onEvent) {
      sendEvent = onEvent;
      fetchCalled.resolve();
      return start.promise;
    },
    async cancel(request) {
      cancelRequests.push(request);
      return cancelled(request, true);
    },
  });

  channel.port2.postMessage(fetchRequest("request-1", "operation-1"));
  await fetchCalled.promise;
  const terminalMessage = nextPortMessage(channel.port2);
  sendEvent(
    providerEvent("operation-1", 0, {
      kind: "body_chunk",
      chunk_base64: "e30=",
    }),
  );
  assert.deepEqual(await terminalMessage, {
    protocol_version: 1,
    operation_id: "operation-1",
    event_index: 0,
    kind: "body_finished",
    status: "error",
    error_message:
      "Native provider emitted a body chunk before response_started.",
  });
  assert.deepEqual(cancelRequests, []);

  const acknowledgement = nextPortMessage(channel.port2);
  start.resolve(fetchStarted(fetchRequest("request-1", "operation-1")));
  assert.equal((await acknowledgement).result.kind, "fetch_started");
  await waitFor(() => cancelRequests.length === 1);
  assert.equal(cancelRequests.length, 1);
  assert.equal(cancelRequests[0].operation_id, "operation-1");

  broker.close();
  channel.port2.close();
});

test("turns cancel command rejection into a correlated error", async () => {
  const channel = new MessageChannel();
  const broker = createNativeProviderPortBroker(channel.port1, {
    async fetch(request) {
      return fetchStarted(request);
    },
    async cancel() {
      throw new Error("native cancel unavailable");
    },
  });

  const response = nextPortMessage(channel.port2);
  channel.port2.postMessage({
    protocol_version: 1,
    request_id: "cancel-request",
    operation_id: "operation-1",
  });
  assert.deepEqual(await response, {
    protocol_version: 1,
    request_id: "cancel-request",
    result: {
      kind: "error",
      error: {
        code: "internal",
        message: "native cancel unavailable",
      },
    },
  });

  broker.close();
  channel.port2.close();
});

test("isolates late body events after a cancel command failure", async () => {
  const channel = new MessageChannel();
  const fetchRequests = [];
  const eventSinks = new Map();
  const cancelRequests = [];
  const broker = createNativeProviderPortBroker(channel.port1, {
    async fetch(request, onEvent) {
      fetchRequests.push(request);
      eventSinks.set(request.operation_id, onEvent);
      return fetchStarted(request);
    },
    async cancel(request) {
      cancelRequests.push(request);
      throw new Error("native cancel unavailable");
    },
  });
  const requestIds = idFactory([
    "fetch-a",
    "fetch-b",
    "cancel-a",
  ]);
  const operationIds = idFactory(["operation-a", "operation-b"]);
  const client = new NativeProviderRpcClient(channel.port2, {
    create_request_id: requestIds,
    create_operation_id: operationIds,
  });
  const firstController = new AbortController();
  const firstResponse = client.fetch_request(
    NATIVE_PROVIDER_MODELS_URL,
    {
      headers: { accept: "application/json" },
      signal: firstController.signal,
    },
  );
  const secondResponse = client.fetch_request(
    NATIVE_PROVIDER_MODELS_URL,
    { headers: { accept: "application/json" } },
  );
  await waitFor(() => fetchRequests.length === 2);

  for (const request of fetchRequests) {
    eventSinks.get(request.operation_id)(
      providerEvent(request.operation_id, 0, {
        kind: "response_started",
        status: 200,
        status_text: "OK",
        headers: { "content-type": "application/json" },
      }),
    );
  }
  const first = await firstResponse;
  const second = await secondResponse;
  const firstBody = first.text();
  firstController.abort();

  await assert.rejects(firstBody, { name: "AbortError" });
  await waitFor(() => cancelRequests.length >= 2);
  eventSinks.get("operation-a")(
    providerEvent("operation-a", 1, {
      kind: "body_finished",
      status: "aborted",
    }),
  );
  eventSinks.get("operation-b")(
    providerEvent("operation-b", 1, {
      kind: "body_chunk",
      chunk_base64: "eyJkYXRhIjpbXX0=",
    }),
  );
  eventSinks.get("operation-b")(
    providerEvent("operation-b", 2, {
      kind: "body_finished",
      status: "complete",
    }),
  );

  assert.deepEqual(await second.json(), { data: [] });
  client.close();
  broker.close();
  channel.port2.close();
});

test("treats a duplicate pending request id as a fatal protocol error", async () => {
  const channel = new MessageChannel();
  const start = deferred();
  const fetchCalled = deferred();
  const cancelRequests = [];
  createNativeProviderPortBroker(channel.port1, {
    fetch() {
      fetchCalled.resolve();
      return start.promise;
    },
    async cancel(request) {
      cancelRequests.push(request);
      return cancelled(request, true);
    },
  });

  channel.port2.postMessage(fetchRequest("duplicate", "operation-1"));
  await fetchCalled.promise;
  const failure = nextPortMessage(channel.port2);
  channel.port2.postMessage(fetchRequest("duplicate", "operation-2"));
  assert.deepEqual(await failure, {
    protocol_version: 1,
    kind: "connection_error",
    error_message:
      "Native provider request_id is already pending: duplicate.",
  });

  start.resolve(fetchStarted(fetchRequest("duplicate", "operation-1")));
  await waitFor(() => cancelRequests.length === 1);
  assert.equal(cancelRequests.length, 1);
  assert.equal(cancelRequests[0].operation_id, "operation-1");

  channel.port2.close();
});

test("closes on a malformed request that cannot be correlated safely", async () => {
  const channel = new MessageChannel();
  createNativeProviderPortBroker(channel.port1, {
    async fetch(request) {
      return fetchStarted(request);
    },
    async cancel(request) {
      return cancelled(request, false);
    },
  });

  const failure = nextPortMessage(channel.port2);
  channel.port2.postMessage({
    protocol_version: 1,
    request_id: " unsafe ",
    operation_id: "operation-1",
  });
  assert.deepEqual(await failure, {
    protocol_version: 1,
    kind: "connection_error",
    error_message:
      "request_id must not contain surrounding whitespace.",
  });

  channel.port2.close();
});

test("rejects duplicate operation ids without disturbing the active fetch", async () => {
  const channel = new MessageChannel();
  const firstStart = deferred();
  const fetchCalled = deferred();
  let fetchCount = 0;
  const broker = createNativeProviderPortBroker(channel.port1, {
    fetch() {
      fetchCount += 1;
      fetchCalled.resolve();
      return firstStart.promise;
    },
    async cancel(request) {
      return cancelled(request, true);
    },
  });

  channel.port2.postMessage(fetchRequest("request-1", "operation-1"));
  await fetchCalled.promise;
  const rejection = nextPortMessage(channel.port2);
  channel.port2.postMessage(fetchRequest("request-2", "operation-1"));
  assert.deepEqual(await rejection, {
    protocol_version: 1,
    request_id: "request-2",
    result: {
      kind: "error",
      error: {
        code: "invalid_request",
        message:
          "Native provider operation_id is already active: operation-1.",
      },
    },
  });
  assert.equal(fetchCount, 1);

  firstStart.resolve(fetchStarted(fetchRequest("request-1", "operation-1")));
  await nextPortMessage(channel.port2);
  broker.close();
  channel.port2.close();
});

function fetchRequest(requestId, operationId) {
  return {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    request_id: requestId,
    operation_id: operationId,
    provider_id: "local-openai",
    endpoint: "models",
    method: "get",
  };
}

function fetchStarted(request) {
  return {
    protocol_version: 1,
    request_id: request.request_id,
    result: {
      kind: "fetch_started",
      operation_id: request.operation_id,
    },
  };
}

function cancelled(request, wasActive) {
  return {
    protocol_version: 1,
    request_id: request.request_id,
    result: {
      kind: "operation_cancelled",
      operation_id: request.operation_id,
      was_active: wasActive,
    },
  };
}

function providerEvent(operationId, eventIndex, event) {
  return {
    protocol_version: 1,
    operation_id: operationId,
    event_index: eventIndex,
    ...event,
  };
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function collectPortMessages(port, count) {
  port.start();
  return new Promise((resolve) => {
    const messages = [];
    const onMessage = (event) => {
      messages.push(event.data);
      if (messages.length !== count) return;
      port.removeEventListener("message", onMessage);
      resolve(messages);
    };
    port.addEventListener("message", onMessage);
  });
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the broker operation.");
    }
    await nextTask();
  }
}
