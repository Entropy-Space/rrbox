/// <reference lib="webworker" />

import init, {
  execute_python_wasm,
} from "../pkg/researchbox_python_plugin.js";
import {
  createPythonWorkerFailure,
} from "./browser-python-executor.ts";
import {
  PYTHON_PROTOCOL_VERSION,
  parsePythonExecuteRequest,
  type PythonExecuteResponse,
} from "./protocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let wasmInitialization: Promise<unknown> | null = null;

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  let request;
  try {
    request = parsePythonExecuteRequest(event.data);
  } catch {
    return;
  }
  wasmInitialization ??= init();
  void wasmInitialization.then(
    () => {
      try {
        const execution = execute_python_wasm(
          request.code,
          request.max_output_bytes,
        );
        const response: PythonExecuteResponse = {
          protocol_version: PYTHON_PROTOCOL_VERSION,
          request_id: request.request_id,
          kind: "python_execute_result",
          result: {
            status: "complete",
            operation_id: request.operation_id,
            execution,
          },
        };
        workerScope.postMessage(response);
      } catch (error) {
        workerScope.postMessage(
          createPythonWorkerFailure(request, error),
        );
      }
    },
    (error) => {
      workerScope.postMessage(
        createPythonWorkerFailure(request, error),
      );
    },
  );
};

export {};
