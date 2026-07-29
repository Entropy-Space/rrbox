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
  DEFAULT_WEB_SEARCH_SUMMARY_GRACE_MS,
  createWebSearchAgentPlugin,
} from "@researchbox/web-search-plugin";
import {
  RoutingWebSearchExecutor,
} from "@researchbox/web-search-plugin/executor";
import {
  ExaMcpWebSearchProvider,
} from "@researchbox/web-search-plugin/providers/exa";
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
    ? new RoutingWebSearchExecutor({
        providers: [
          new ExaMcpWebSearchProvider(
            initialization.web_search_plugin,
          ),
        ],
        default_provider:
          initialization.web_search_plugin.provider,
      })
    : null;
  const plugins = [
    ...(pythonExecutor
      ? [createPythonAgentPlugin(pythonExecutor)]
      : []),
    ...(webSearchExecutor
      ? [createWebSearchAgentPlugin(
          webSearchExecutor,
          {
            maximum_results:
              initialization.web_search_plugin.maximum_results,
            maximum_output_bytes:
              initialization.web_search_plugin.max_output_bytes,
            default_provider:
              initialization.web_search_plugin.provider,
            default_workflow:
              initialization.web_search_plugin.workflow,
            summary_timeout_ms:
              initialization.web_search_plugin.summary_timeout_ms,
            review_timeout_ms:
              initialization.web_search_plugin.review_timeout_ms,
            summary_grace_ms: DEFAULT_WEB_SEARCH_SUMMARY_GRACE_MS,
          },
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
