/// <reference lib="webworker" />

import {
  createResearchBoxProviderDefinitions,
  startResearchBoxCoreWorker,
} from "@researchbox/app-runtime-browser/core-worker";
import type { WorkerHost } from "@researchbox/runtime-browser";
import {
  BrowserPythonExecutor,
} from "@researchbox/python-plugin/browser";
import { createPythonAgentPlugin } from "@researchbox/python-plugin";
import {
  parseWebCoreWorkerInitializeMessage,
} from "./core-worker-initialization.ts";

const host = self as unknown as WorkerHost;

host.onmessage = (event) => {
  const initialization = parseWebCoreWorkerInitializeMessage(
    event.data,
  );
  const pythonExecutor = initialization.python_plugin.enabled
    ? new BrowserPythonExecutor({
        timeout_ms: initialization.python_plugin.timeout_ms,
        max_output_bytes:
          initialization.python_plugin.max_output_bytes,
        createWorker() {
          return new Worker(
            new URL("./python.worker.ts", import.meta.url),
            {
              type: "module",
              name: "researchbox-python",
            },
          );
        },
      })
    : null;

  startResearchBoxCoreWorker({
    host,
    lock_manager: navigator.locks,
    plugins: pythonExecutor
      ? [createPythonAgentPlugin(pythonExecutor)]
      : [],
    close_plugins: pythonExecutor
      ? () => pythonExecutor.close()
      : undefined,
    providers: createResearchBoxProviderDefinitions({
      include_local_openai: true,
    }),
    create_model_worker() {
      return new Worker(new URL("./llm.worker.ts", import.meta.url), {
        type: "module",
        name: "researchbox-llm",
      });
    },
  });
};

export {};
