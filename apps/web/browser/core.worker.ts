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
import { createWebSearchAgentPlugin } from "@researchbox/web-search-plugin";
import {
  ExaMcpWebSearchExecutor,
} from "@researchbox/web-search-plugin/executor";
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
  const webSearchExecutor = initialization.web_search_plugin.enabled
    ? new ExaMcpWebSearchExecutor(initialization.web_search_plugin)
    : null;
  const plugins = [
    ...(pythonExecutor
      ? [createPythonAgentPlugin(pythonExecutor)]
      : []),
    ...(webSearchExecutor
      ? [createWebSearchAgentPlugin(
          webSearchExecutor,
          initialization.web_search_plugin.maximum_results,
        )]
      : []),
  ];

  startResearchBoxCoreWorker({
    host,
    lock_manager: navigator.locks,
    plugins,
    close_plugins:
      pythonExecutor || webSearchExecutor
        ? async () => {
            await pythonExecutor?.close();
            await webSearchExecutor?.close();
          }
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
