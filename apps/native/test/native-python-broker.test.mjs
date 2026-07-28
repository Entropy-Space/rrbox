import assert from "node:assert/strict";
import test from "node:test";
import { createNativePythonPortBroker } from "../src/lib/native-python-broker.ts";
import {
  PYTHON_PROTOCOL_VERSION,
  createPythonExecuteRequest,
  parsePythonResponse,
} from "@researchbox/python-plugin/protocol";

test("brokers native Python execution responses", async () => {
  const channel = new MessageChannel();
  const broker = createNativePythonPortBroker(channel.port1, {
    async execute(request) {
      return {
        protocol_version: PYTHON_PROTOCOL_VERSION,
        request_id: request.request_id,
        kind: "python_execute_result",
        result: {
          status: "complete",
          operation_id: request.operation_id,
          execution: {
            stdout: "42\n",
            stderr: "",
            error: null,
            output_truncated: false,
          },
        },
      };
    },
    async cancel(request) {
      return {
        protocol_version: PYTHON_PROTOCOL_VERSION,
        request_id: request.request_id,
        kind: "python_cancel_result",
        result: {
          status: "cancelled",
          operation_id: request.operation_id,
        },
      };
    },
  });
  const response = new Promise((resolve) => {
    channel.port2.onmessage = (event) => resolve(event.data);
  });
  channel.port2.postMessage(
    createPythonExecuteRequest("print(42)", {
      request_id: "request",
      operation_id: "operation",
    }),
  );

  const parsed = parsePythonResponse(await response);
  assert.equal(parsed.result.status, "complete");
  broker.close();
  channel.port2.close();
});
