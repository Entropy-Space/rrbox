import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCHBOX_WRITER_LOCK,
  withExclusiveWriterLease,
} from "../browser/writer-lease.ts";

test("browser cores request one origin-wide exclusive writer lease", async () => {
  const requests = [];
  const lockManager = {
    async request(name, options, operation) {
      requests.push({ name, options });
      return operation({ name, mode: "exclusive" });
    },
  };

  const result = await withExclusiveWriterLease(
    lockManager,
    async () => "started",
  );

  assert.equal(result, "started");
  assert.deepEqual(requests, [
    {
      name: RESEARCHBOX_WRITER_LOCK,
      options: { mode: "exclusive", ifAvailable: true },
    },
  ]);
});

test("a contending core reports waiting before queued promotion", async () => {
  const requests = [];
  const states = [];
  const lockManager = {
    async request(name, options, operation) {
      requests.push({ name, options });
      return operation(
        options.ifAvailable ? null : { name, mode: "exclusive" },
      );
    },
  };

  const result = await withExclusiveWriterLease(
    lockManager,
    async () => {
      states.push("started");
      return "promoted";
    },
    { onWaiting: () => states.push("waiting") },
  );

  assert.equal(result, "promoted");
  assert.deepEqual(states, ["waiting", "started"]);
  assert.deepEqual(requests, [
    {
      name: RESEARCHBOX_WRITER_LOCK,
      options: { mode: "exclusive", ifAvailable: true },
    },
    { name: RESEARCHBOX_WRITER_LOCK, options: { mode: "exclusive" } },
  ]);
});

test("only the queued lock request carries the abort signal", async () => {
  const requests = [];
  const controller = new AbortController();
  const lockManager = {
    async request(name, options, operation) {
      requests.push({ name, options });
      return operation(
        options.ifAvailable ? null : { name, mode: "exclusive" },
      );
    },
  };

  await withExclusiveWriterLease(
    lockManager,
    async () => "promoted",
    { signal: controller.signal },
  );

  assert.deepEqual(requests, [
    {
      name: RESEARCHBOX_WRITER_LOCK,
      options: { mode: "exclusive", ifAvailable: true },
    },
    {
      name: RESEARCHBOX_WRITER_LOCK,
      options: { mode: "exclusive", signal: controller.signal },
    },
  ]);
});
