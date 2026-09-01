/// <reference lib="webworker" />

import "@dshrbox/runtime-browser/install";
import {
  createResearchBoxProviderDefinitions,
  startResearchBoxCoreWorker,
} from "@researchbox/app-runtime-browser/core-worker";
import { researchBoxSeedFiles } from "@researchbox/app-runtime-browser/seed-files";
import {
  DSH_BROWSER_COMPATIBILITY,
} from "@dshrbox/runtime-browser";
import {
  IndexedDbDshrboxSessionBackend,
} from "@dshrbox/session-persistence-browser";
import {
  DshrboxSessionRuntimeProvider,
} from "@dshrbox/session-runtime";
import type { WorkerHost } from "@researchbox/runtime-browser";
import {
  BrowserWorkspaceBackend,
  IndexedDbProjectStore,
  ResearchBoxDatabase,
} from "@researchbox/storage-browser";
import {
  BrowserPythonExecutor,
} from "@researchbox/python-plugin/browser";
import { DshrboxPython } from "@researchbox/python-plugin/dsh";
import {
  DEFAULT_WEB_SEARCH_SUMMARY_GRACE_MS,
} from "@researchbox/web-search-plugin";
import {
  DshrboxWebResearch,
} from "@researchbox/web-search-plugin/dsh";
import {
  RoutingWebSearchExecutor,
} from "@researchbox/web-search-plugin/executor";
import {
  ExaMcpWebSearchProvider,
} from "@researchbox/web-search-plugin/providers/exa";
import {
  parseWebCoreWorkerInitializeMessage,
  WEB_LLM_WORKER_PROTOCOL_VERSION,
  type WebLlmWorkerInitializeMessage,
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
  const webSearchOptions = {
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
  };
  const dshPlugins = [
    ...(pythonExecutor
      ? [{
          plugin: DshrboxPython,
          config: { executor: pythonExecutor },
        }]
      : []),
    ...(webSearchExecutor
      ? [{
          plugin: DshrboxWebResearch,
          config: {
            executor: webSearchExecutor,
            ...webSearchOptions,
          },
        }]
      : []),
  ];

  startResearchBoxCoreWorker({
    host,
    lock_manager: navigator.locks,
    close_plugins:
      pythonExecutor || webSearchExecutor
        ? async () => {
            await pythonExecutor?.close();
            await webSearchExecutor?.close();
          }
        : undefined,
    providers: createResearchBoxProviderDefinitions({
      providers: initialization.providers,
    }),
    create_storage_services() {
      const database = new ResearchBoxDatabase();
      const projectStore = new IndexedDbProjectStore(database);
      return {
        projectStore,
        workspaceBackend: new BrowserWorkspaceBackend(
          database,
          researchBoxSeedFiles,
        ),
        sessionRuntimeProvider: new DshrboxSessionRuntimeProvider({
          session_backend: new IndexedDbDshrboxSessionBackend(database),
          plugins: dshPlugins,
          max_parallel_tool_calls:
            DSH_BROWSER_COMPATIBILITY.max_parallel_tool_calls,
        }),
        close() {
          projectStore.close();
          database.close();
        },
      };
    },
    create_model_worker() {
      const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), {
        type: "module",
        name: "researchbox-llm",
      });
      const llmInitialization: WebLlmWorkerInitializeMessage = {
        protocol_version: WEB_LLM_WORKER_PROTOCOL_VERSION,
        kind: "web_llm_initialize",
        providers: initialization.providers,
      };
      try {
        worker.postMessage(llmInitialization);
      } catch (error) {
        worker.terminate();
        throw error;
      }
      return worker;
    },
  });
};

export {};
