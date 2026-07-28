import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPythonExecutor } from "../src/browser-python-executor.ts";
import { PYTHON_PROTOCOL_VERSION } from "../src/protocol.ts";

class FakeWorker extends EventTarget {
  messages = [];
  terminated = false;

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  complete(execution) {
    const request = this.messages.at(-1);
    this.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocol_version: PYTHON_PROTOCOL_VERSION,
          request_id: request.request_id,
          kind: "python_execute_result",
          result: {
            status: "complete",
            operation_id: request.operation_id,
            execution,
          },
        },
      }),
    );
  }
}

test("creates the Python Worker lazily and reuses it", async () => {
  const workers = [];
  const executor = new BrowserPythonExecutor({
    createWorker() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });

  assert.equal(workers.length, 0);
  const first = executor.execute("print(1)");
  assert.equal(workers.length, 1);
  workers[0].complete({
    stdout: "1\n",
    stderr: "",
    error: null,
    output_truncated: false,
  });
  assert.equal((await first).stdout, "1\n");

  const second = executor.execute("print(2)");
  assert.equal(workers.length, 1);
  workers[0].complete({
    stdout: "2\n",
    stderr: "",
    error: null,
    output_truncated: false,
  });
  assert.equal((await second).stdout, "2\n");
  executor.close();
  assert.equal(workers[0].terminated, true);
});

test("terminates the Worker on abort and recreates it later", async () => {
  const workers = [];
  const executor = new BrowserPythonExecutor({
    createWorker() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const controller = new AbortController();
  const execution = executor.execute("while True: pass", controller.signal);
  controller.abort();
  await assert.rejects(execution, { name: "AbortError" });
  assert.equal(workers[0].terminated, true);

  const next = executor.execute("print(42)");
  assert.equal(workers.length, 2);
  workers[1].complete({
    stdout: "42\n",
    stderr: "",
    error: null,
    output_truncated: false,
  });
  await next;
  executor.close();
});
