import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "@researchbox/protocol";
import { attachWorkerHost } from "../src/index.ts";

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
