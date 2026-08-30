/// <reference lib="webworker" />

import {
  createResearchBoxProviderDefinitions,
  startResearchBoxCoreWorker,
} from "@researchbox/app-runtime-browser/core-worker";
import { researchBoxSeedFiles } from "@researchbox/app-runtime-browser/seed-files";
import {
  InMemoryCommandLockManager,
} from "@researchbox/app-runtime-browser/command-coordinator";
import type { WorkerHost } from "@researchbox/runtime-browser";
import {
  NativeProjectStore,
  NativeStorageRpcClient,
  NativeWorkspaceBackend,
} from "@researchbox/storage-native";
import {
  NATIVE_LLM_WORKER_PROTOCOL_VERSION,
  parseNativeCoreWorkerInitializeMessage,
  type NativeLlmWorkerInitializeMessage,
} from "../lib/types.ts";
import { createPythonAgentPlugin } from "@researchbox/python-plugin";
import {
  NativePythonRpcClient,
} from "@researchbox/python-plugin/native";
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
  NativeAnySearchWebSearchProvider,
} from "@researchbox/web-search-plugin/native";
import {
  NativeUrlReader,
} from "@researchbox/web-search-plugin/native-url-reader";
import {
  webSearchRoutingProviderIds,
} from "@researchbox/web-search-plugin/settings";

const host = self as unknown as WorkerHost;
const workerNavigator = navigator as WorkerNavigator & {
  locks?: LockManager;
};
// The current native app has one WebView. Older WKWebView releases do not
// expose Web Locks, so retain intra-worker serialization until native IPC owns
// coordination. This fallback must not be reused for a multi-window native app.
const lockManager =
  workerNavigator.locks ?? new InMemoryCommandLockManager();

host.onmessage = (event) => {
  const initialization = parseNativeCoreWorkerInitializeMessage(
    event.data,
  );
  const storageClient = new NativeStorageRpcClient(
    initialization.storage_port,
  );
  const projectStore = new NativeProjectStore(storageClient);
  const pythonClient = initialization.python_plugin.enabled
    ? new NativePythonRpcClient(
        initialization.python_port,
        {
          timeout_ms: initialization.python_plugin.timeout_ms,
          max_output_bytes:
            initialization.python_plugin.max_output_bytes,
        },
      )
    : null;
  const webSearchExecutor = initialization.web_search_plugin.enabled
    ? new RoutingWebSearchExecutor({
        providers: [
          new ExaMcpWebSearchProvider(
            initialization.web_search_plugin,
          ),
          new NativeAnySearchWebSearchProvider(
            initialization.web_search_port,
            {
              timeout_ms:
                initialization.web_search_plugin.timeout_ms,
            },
          ),
        ],
        default_provider:
          initialization.web_search_plugin.provider,
        routing: {
          providers: webSearchRoutingProviderIds(
            initialization.web_search_plugin.routing_order,
          ),
          fallback_on: ["transient", "quota", "network"],
        },
      })
    : null;
  const urlReader = initialization.web_search_plugin.enabled
    ? new NativeUrlReader(initialization.url_reader_port, {
        timeout_ms: initialization.web_search_plugin.timeout_ms,
      })
    : null;
  const legacyPlugins = [
    ...(pythonClient
      ? [createPythonAgentPlugin(pythonClient)]
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
            ...(urlReader ? { url_reader: urlReader } : {}),
          },
        )]
      : []),
  ];

  startResearchBoxCoreWorker({
    host,
    lock_manager: lockManager,
    providers: createResearchBoxProviderDefinitions({
      providers: initialization.providers,
    }),
    legacy_plugins: legacyPlugins,
    close_plugins:
      pythonClient || webSearchExecutor || urlReader
        ? async () => {
            await pythonClient?.close();
            await webSearchExecutor?.close();
            await urlReader?.close();
          }
        : undefined,
    create_storage_services() {
      return {
        projectStore,
        workspaceBackend: new NativeWorkspaceBackend(storageClient, {
          default_initial_files: researchBoxSeedFiles,
        }),
        close() {
          projectStore.close();
          storageClient.close();
        },
      };
    },
    create_model_worker() {
      const worker = new Worker(
        new URL("./llm.worker.ts", import.meta.url),
        {
          type: "module",
          name: "researchbox-llm",
        },
      );
      const llmInitialization: NativeLlmWorkerInitializeMessage = {
        protocol_version: NATIVE_LLM_WORKER_PROTOCOL_VERSION,
        kind: "native_llm_initialize",
        provider_port: initialization.provider_port,
        providers: initialization.providers,
      };
      try {
        worker.postMessage(llmInitialization, [
          initialization.provider_port,
        ]);
      } catch (error) {
        worker.terminate();
        initialization.provider_port.close();
        throw error;
      }
      return worker;
    },
  });
};

export {};
