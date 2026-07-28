import assert from "node:assert/strict";
import test from "node:test";
import { NativePythonRpcClient } from "../src/native-python-rpc-client.ts";
import {
  PYTHON_PROTOCOL_VERSION,
  parsePythonRequest,
} from "../src/protocol.ts";

test("executes over the native Python port", async () => {
  const channel = new MessageChannel();
  channel.port2.onmessage = (event) => {
    const request = parsePythonRequest(event.data);
    assert.equal(request.kind, "python_execute");
    channel.port2.postMessage({
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
    });
  };
  const client = new NativePythonRpcClient(channel.port1);

  const result = await client.execute("print(42)");
  assert.equal(result.stdout, "42\n");
  client.close();
  channel.port2.close();
});

test("sends cancellation when an execution is aborted", async () => {
  const channel = new MessageChannel();
  let executeRequest;
  let cancelRequest;
  channel.port2.onmessage = (event) => {
    const request = parsePythonRequest(event.data);
    if (request.kind === "python_execute") {
      executeRequest = request;
      return;
    }
    cancelRequest = request;
    channel.port2.postMessage({
      protocol_version: PYTHON_PROTOCOL_VERSION,
      request_id: request.request_id,
      kind: "python_cancel_result",
      result: {
        status: "cancelled",
        operation_id: request.operation_id,
      },
    });
    channel.port2.postMessage({
      protocol_version: PYTHON_PROTOCOL_VERSION,
      request_id: executeRequest.request_id,
      kind: "python_execute_result",
      result: {
        status: "error",
        code: "cancelled",
        message: "Python execution was cancelled.",
      },
    });
  };
  const client = new NativePythonRpcClient(channel.port1);
  const controller = new AbortController();
  const execution = client.execute("while True: pass", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();

  await assert.rejects(execution, { name: "AbortError" });
  assert.equal(cancelRequest.operation_id, executeRequest.operation_id);
  client.close();
  channel.port2.close();
});
