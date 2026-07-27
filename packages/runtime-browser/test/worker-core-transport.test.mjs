import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  createCommand,
} from "@researchbox/protocol";
import { WorkerCoreTransport } from "../src/index.ts";

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
});

test("closes and detaches the worker exactly once", () => {
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

  assert.equal(detached.terminateCount(), 1);
  assert.deepEqual(events, []);
  assert.throws(
    () => transport.send(createCommand("bootstrap", {})),
    /transport is closed/,
  );
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
