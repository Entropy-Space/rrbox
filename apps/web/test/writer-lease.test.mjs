import assert from "node:assert/strict";
import test from "node:test";
import {
  queueMessagesUntilStarted,
  RESEARCHBOX_WRITER_LOCK,
  withExclusiveWriterLease,
} from "../browser/writer-lease.ts";

test("browser cores request one origin-wide exclusive writer lease", async () => {
  const requests = [];
  const lockManager = {
    async request(name, options, operation) {
      requests.push({ name, options });
      return operation();
    },
  };

  const result = await withExclusiveWriterLease(
    lockManager,
    async () => "started",
  );

  assert.equal(result, "started");
  assert.deepEqual(requests, [
    { name: RESEARCHBOX_WRITER_LOCK, options: { mode: "exclusive" } },
  ]);
});

test("worker commands wait in order until the writer lease starts", () => {
  const host = { onmessage: null };
  const drain = queueMessagesUntilStarted(host);
  host.onmessage({ data: "first" });
  host.onmessage({ data: "second" });

  const received = [];
  host.onmessage = (message) => received.push(message.data);
  drain();

  assert.deepEqual(received, ["first", "second"]);
});
