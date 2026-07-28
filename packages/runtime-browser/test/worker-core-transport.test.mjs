import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  createCommand,
} from "@researchbox/protocol";
import {
  createCoreWorkerDisposeRequest,
  createCoreWorkerDisposedAck,
  WorkerCoreTransport,
} from "../src/index.ts";

test("sends commands and delivers validated core events", () => {
  const detached = createDetachedWorker();
  const transport = new WorkerCoreTransport(detached.worker);
  const events = [];
  const failures = [];
  transport.subscribe(
    (event) => events.push(event),
    (failure) => failures.push(failure),
  );
  const command = createCommand("bootstrap", {});

  transport.send(command);
  detached.emitMessage(coreLifecycleEvent("event-1"));

  assert.deepEqual(detached.commands, [command]);
  assert.deepEqual(events, [coreLifecycleEvent("event-1")]);
  assert.deepEqual(failures, []);
});

test("rejects malformed and unserializable core events at the boundary", () => {
  const detached = createDetachedWorker();
  const transport = new WorkerCoreTransport(detached.worker);
  const failures = [];
  transport.subscribe(
    () => assert.fail("Invalid events must not reach subscribers."),
    (failure) => failures.push(failure),
  );

  detached.emitMessage({ type: "unknown" });
  detached.emitMessageError();

  assert.deepEqual(failures, ["invalid_event", "invalid_event"]);
});

test("maps worker failures without coupling subscribers to browser events", () => {
  const detached = createDetachedWorker();
  const transport = new WorkerCoreTransport(detached.worker);
  const failures = [];
  const unsubscribe = transport.subscribe(
    () => undefined,
    (failure) => failures.push(failure),
  );

  detached.emitError();
  unsubscribe();
  detached.emitError();

  assert.deepEqual(failures, ["transport_error"]);
  assert.equal(detached.terminateCount(), 1);
  assert.throws(
    () => transport.send(createCommand("bootstrap", {})),
    /transport is closed/,
  );
});

test("fatal worker events close transport-owned resources", () => {
  for (const current of [
    {
      emit(detached) {
        detached.emitError();
      },
      failure: "transport_error",
    },
    {
      emit(detached) {
        detached.emitMessageError();
      },
      failure: "invalid_event",
    },
  ]) {
    const detached = createDetachedWorker();
    const failures = [];
    let closeNotifications = 0;
    const transport = new WorkerCoreTransport(detached.worker, {
      onClosed() {
        closeNotifications += 1;
      },
    });
    transport.subscribe(
      () => undefined,
      (failure) => failures.push(failure),
    );

    current.emit(detached);
    current.emit(detached);
    transport.close();

    assert.deepEqual(failures, [current.failure]);
    assert.equal(detached.terminateCount(), 1);
    assert.equal(closeNotifications, 1);
  }
});

test("waits for graceful disposal acknowledgement before terminating", () => {
  const detached = createDetachedWorker();
  const transport = new WorkerCoreTransport(detached.worker);
  const events = [];
  transport.subscribe(
    (event) => events.push(event),
    () => undefined,
  );

  transport.close();
  transport.close();
  detached.emitMessage(coreLifecycleEvent("event-after-close"));

  assert.deepEqual(detached.commands, [createCoreWorkerDisposeRequest()]);
  assert.equal(detached.terminateCount(), 0);
  assert.deepEqual(events, []);
  assert.throws(
    () => transport.send(createCommand("bootstrap", {})),
    /transport is closed/,
  );

  detached.emitMessage(createCoreWorkerDisposedAck());
  detached.emitMessage(createCoreWorkerDisposedAck());
  assert.equal(detached.terminateCount(), 1);
});

test("forces termination when graceful disposal does not acknowledge", async () => {
  const detached = createDetachedWorker();
  const transport = new WorkerCoreTransport(detached.worker, {
    disposeTimeoutMs: 5,
  });

  transport.close();
  assert.equal(detached.terminateCount(), 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(detached.terminateCount(), 1);
  assert.deepEqual(detached.commands, [createCoreWorkerDisposeRequest()]);
});

test("notifies resource owners after the worker is closed", () => {
  const detached = createDetachedWorker();
  let closeNotifications = 0;
  const transport = new WorkerCoreTransport(detached.worker, {
    onClosed() {
      closeNotifications += 1;
    },
  });

  transport.close();
  assert.equal(closeNotifications, 0);
  detached.emitMessage(createCoreWorkerDisposedAck());
  detached.emitMessage(createCoreWorkerDisposedAck());

  assert.equal(closeNotifications, 1);
  assert.equal(detached.terminateCount(), 1);
});

function coreLifecycleEvent(eventId) {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: eventId,
    type: "core_lifecycle",
    payload: {
      phase: "initializing_workspace",
    },
  };
}

function createDetachedWorker() {
  const listeners = new Map([
    ["message", new Set()],
    ["error", new Set()],
    ["messageerror", new Set()],
  ]);
  const commands = [];
  let terminationCount = 0;
  const worker = {
    addEventListener(type, listener) {
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(command) {
      commands.push(command);
    },
    terminate() {
      terminationCount += 1;
    },
  };

  return {
    worker,
    commands,
    emitMessage(data) {
      for (const listener of listeners.get("message") ?? []) {
        listener(new MessageEvent("message", { data }));
      }
    },
    emitError() {
      for (const listener of listeners.get("error") ?? []) {
        listener(new Event("error"));
      }
    },
    emitMessageError() {
      for (const listener of listeners.get("messageerror") ?? []) {
        listener(new MessageEvent("messageerror"));
      }
    },
    terminateCount() {
      return terminationCount;
    },
  };
}
