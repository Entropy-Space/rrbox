import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@researchbox/protocol";
import {
  attachCoreWorkerLifecycle,
  attachWorkerHost,
  createCoreWorkerDisposeRequest,
  createCoreWorkerDisposedAck,
} from "../src/index.ts";

test("validates commands before forwarding them to the core", async () => {
  const handled = [];
  const errors = [];
  const host = {
    onmessage: null,
    postMessage() {},
  };
  const core = {
    async handle(command) {
      handled.push(command);
    },
    reportHostError(code, message, requestId) {
      errors.push({ code, message, request_id: requestId });
    },
  };
  attachWorkerHost(host, core);

  host.onmessage?.(
    new MessageEvent("message", {
      data: {
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-1",
        type: "bootstrap",
        payload: {},
      },
    }),
  );
  await Promise.resolve();
  assert.equal(handled.length, 1);

  host.onmessage?.(new MessageEvent("message", { data: { type: "unknown" } }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.code, "invalid_command");
});

test("distinguishes command failures from invalid commands", async () => {
  const errors = [];
  const host = {
    onmessage: null,
    postMessage() {},
  };
  const core = {
    async handle() {
      throw new Error("bootstrap failed");
    },
    reportHostError(code, message, requestId) {
      errors.push({ code, message, request_id: requestId });
    },
  };
  attachWorkerHost(host, core);

  host.onmessage?.(
    new MessageEvent("message", {
      data: {
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-2",
        type: "bootstrap",
        payload: {},
      },
    }),
  );
  await Promise.resolve();

  assert.deepEqual(errors, [
    {
      code: "command_failed",
      message: "bootstrap failed",
      request_id: "request-2",
    },
  ]);
});

test("acknowledges disposal only after active core cleanup drains", async () => {
  const commandGate = deferred();
  const disposed = [];
  const posted = [];
  const host = {
    onmessage: null,
    postMessage(message) {
      posted.push(message);
    },
  };
  const core = {
    handle() {
      return commandGate.promise;
    },
    reportHostError() {},
  };
  attachWorkerHost(host, core);
  attachCoreWorkerLifecycle(host, async () => {
    disposed.push("started");
    await commandGate.promise;
    disposed.push("finished");
  });

  host.onmessage?.(
    new MessageEvent("message", {
      data: {
        protocol_version: PROTOCOL_VERSION,
        request_id: "request-pending",
        type: "bootstrap",
        payload: {},
      },
    }),
  );
  host.onmessage?.(
    new MessageEvent("message", {
      data: createCoreWorkerDisposeRequest(),
    }),
  );
  await Promise.resolve();

  assert.deepEqual(disposed, ["started"]);
  assert.deepEqual(posted, []);

  commandGate.resolve();
  await flushTasks();
  assert.deepEqual(disposed, ["started", "finished"]);
  assert.deepEqual(posted, [createCoreWorkerDisposedAck()]);
});

test("shares one idempotent disposal across repeated requests", async () => {
  const disposalGate = deferred();
  let disposeCount = 0;
  const posted = [];
  const host = {
    onmessage: null,
    postMessage(message) {
      posted.push(message);
    },
  };
  attachWorkerHost(host, {
    async handle() {},
    reportHostError() {},
  });
  attachCoreWorkerLifecycle(host, async () => {
    disposeCount += 1;
    await disposalGate.promise;
  });

  const disposeMessage = new MessageEvent("message", {
    data: createCoreWorkerDisposeRequest(),
  });
  host.onmessage?.(disposeMessage);
  host.onmessage?.(disposeMessage);
  await Promise.resolve();
  assert.equal(disposeCount, 1);

  disposalGate.resolve();
  await flushTasks();
  assert.equal(disposeCount, 1);
  assert.deepEqual(posted, [
    createCoreWorkerDisposedAck(),
    createCoreWorkerDisposedAck(),
  ]);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}
