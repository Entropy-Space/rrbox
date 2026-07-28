import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PYTHON_CODE_BYTES,
  PYTHON_PROTOCOL_VERSION,
  createPythonExecuteRequest,
  parsePythonRequest,
  parsePythonResponse,
} from "../src/protocol.ts";

test("validates strict versioned Python messages", () => {
  const request = createPythonExecuteRequest("print(42)", {
    request_id: "request-1",
    operation_id: "operation-1",
    timeout_ms: 1_000,
    max_output_bytes: 4_096,
  });

  assert.deepEqual(parsePythonRequest(request), request);
  assert.throws(
    () => parsePythonRequest({ ...request, extra: true }),
    /invalid fields/u,
  );
  assert.throws(
    () =>
      parsePythonRequest({
        ...request,
        protocol_version: PYTHON_PROTOCOL_VERSION + 1,
      }),
    /Unsupported Python protocol version/u,
  );
  assert.throws(
    () =>
      createPythonExecuteRequest("x".repeat(MAX_PYTHON_CODE_BYTES + 1)),
    /code exceeds/u,
  );
});

test("validates execution output without accepting extra fields", () => {
  const response = {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id: "request-1",
    kind: "python_execute_result",
    result: {
      status: "complete",
      operation_id: "operation-1",
      execution: {
        stdout: "42\n",
        stderr: "",
        error: null,
        output_truncated: false,
      },
    },
  };

  assert.deepEqual(parsePythonResponse(response), response);
  assert.throws(
    () =>
      parsePythonResponse({
        ...response,
        result: {
          ...response.result,
          execution: {
            ...response.result.execution,
            extra: true,
          },
        },
      }),
    /invalid fields/u,
  );
});
