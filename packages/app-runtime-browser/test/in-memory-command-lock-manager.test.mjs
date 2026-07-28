import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryCommandLockManager,
} from "../src/command-coordinator.ts";

test("runs a FIFO shared cohort before a writer and later readers", async () => {
  const manager = new InMemoryCommandLockManager();
  const firstReaderGate = deferred();
  const secondReaderGate = deferred();
  const writerGate = deferred();
  const started = [];
  const tokens = [];

  const firstReader = manager.request(
    "workspace",
    { mode: "shared" },
    async (lock) => {
      started.push("reader-1");
      tokens.push(lock);
      await firstReaderGate.promise;
    },
  );
  const secondReader = manager.request(
    "workspace",
    { mode: "shared" },
    async (lock) => {
      started.push("reader-2");
      tokens.push(lock);
      await secondReaderGate.promise;
    },
  );
  const writer = manager.request(
    "workspace",
    { mode: "exclusive" },
    async (lock) => {
      started.push("writer");
      tokens.push(lock);
      await writerGate.promise;
    },
  );
  const lateReader = manager.request(
    "workspace",
    { mode: "shared" },
    (lock) => {
      started.push("late-reader");
      tokens.push(lock);
    },
  );

  await flushTasks();
  assert.deepEqual(started, ["reader-1", "reader-2"]);

  firstReaderGate.resolve();
  await firstReader;
  await flushTasks();
  assert.deepEqual(started, ["reader-1", "reader-2"]);

  secondReaderGate.resolve();
  await secondReader;
  await waitForCondition(() => started.includes("writer"));
  assert.equal(started.includes("late-reader"), false);

  writerGate.resolve();
  await Promise.all([writer, lateReader]);
  assert.deepEqual(started, [
    "reader-1",
    "reader-2",
    "writer",
    "late-reader",
  ]);
  assert.deepEqual(
    tokens.map((lock) => lock && {
      name: lock.name,
      mode: lock.mode,
      frozen: Object.isFrozen(lock),
    }),
    [
      { name: "workspace", mode: "shared", frozen: true },
      { name: "workspace", mode: "shared", frozen: true },
      { name: "workspace", mode: "exclusive", frozen: true },
      { name: "workspace", mode: "shared", frozen: true },
    ],
  );
});

test("aborting a queued writer lets readers behind it join the active cohort", async () => {
  const manager = new InMemoryCommandLockManager();
  const activeReaderGate = deferred();
  const lateReaderGate = deferred();
  const controller = new AbortController();
  const abortReason = new Error("No longer needed");
  const started = [];

  const activeReader = manager.request(
    "workspace",
    { mode: "shared" },
    async () => {
      started.push("active-reader");
      await activeReaderGate.promise;
    },
  );
  const writer = manager.request(
    "workspace",
    { mode: "exclusive", signal: controller.signal },
    () => {
      started.push("aborted-writer");
    },
  );
  const lateReader = manager.request(
    "workspace",
    { mode: "shared" },
    async () => {
      started.push("late-reader");
      await lateReaderGate.promise;
    },
  );

  await flushTasks();
  assert.deepEqual(started, ["active-reader"]);

  controller.abort(abortReason);
  await assert.rejects(writer, (error) => error === abortReason);
  await waitForCondition(() => started.includes("late-reader"));
  assert.deepEqual(started, ["active-reader", "late-reader"]);

  activeReaderGate.resolve();
  lateReaderGate.resolve();
  await Promise.all([activeReader, lateReader]);
});

test("an already-aborted request never reaches its operation", async () => {
  const manager = new InMemoryCommandLockManager();
  const controller = new AbortController();
  controller.abort();
  let wasCalled = false;

  await assert.rejects(
    manager.request(
      "workspace",
      { mode: "exclusive", signal: controller.signal },
      () => {
        wasCalled = true;
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(wasCalled, false);
});

test("aborting after acquisition does not cancel the active operation", async () => {
  const manager = new InMemoryCommandLockManager();
  const controller = new AbortController();
  const operationGate = deferred();
  let started = false;

  const active = manager.request(
    "workspace",
    { mode: "exclusive", signal: controller.signal },
    async () => {
      started = true;
      await operationGate.promise;
      return "complete";
    },
  );

  await waitForCondition(() => started);
  controller.abort();
  operationGate.resolve();
  assert.equal(await active, "complete");
});

test("releases locks before settling synchronous and asynchronous failures", async () => {
  const manager = new InMemoryCommandLockManager();
  const synchronousError = new Error("Synchronous failure");
  const asynchronousError = new Error("Asynchronous failure");
  const started = [];

  const synchronousFailure = manager.request(
    "workspace",
    { mode: "exclusive" },
    () => {
      started.push("sync-failure");
      throw synchronousError;
    },
  );
  const asynchronousFailure = manager.request(
    "workspace",
    { mode: "exclusive" },
    async () => {
      started.push("async-failure");
      throw asynchronousError;
    },
  );
  const success = manager.request(
    "workspace",
    { mode: "exclusive" },
    () => {
      started.push("success");
      return 42;
    },
  );

  await assert.rejects(
    synchronousFailure,
    (error) => error === synchronousError,
  );
  await assert.rejects(
    asynchronousFailure,
    (error) => error === asynchronousError,
  );
  assert.equal(await success, 42);
  assert.deepEqual(started, [
    "sync-failure",
    "async-failure",
    "success",
  ]);
});

test("allows unrelated lock names to run concurrently", async () => {
  const manager = new InMemoryCommandLockManager();
  const firstGate = deferred();
  const started = [];

  const first = manager.request(
    "project-a",
    { mode: "exclusive" },
    async () => {
      started.push("project-a");
      await firstGate.promise;
    },
  );
  const second = manager.request(
    "project-b",
    { mode: "exclusive" },
    () => {
      started.push("project-b");
    },
  );

  await waitForCondition(() => started.includes("project-b"));
  assert.deepEqual(started, ["project-a", "project-b"]);
  firstGate.resolve();
  await Promise.all([first, second]);
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

async function waitForCondition(condition) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await flushTasks();
  }
  assert.fail("Timed out waiting for the in-memory lock request.");
}
