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

  startResearchBoxCoreWorker({
    host,
    lock_manager: lockManager,
    providers: createResearchBoxProviderDefinitions({
      include_local_openai: true,
    }),
    plugins: pythonClient
      ? [createPythonAgentPlugin(pythonClient)]
      : [],
    close_plugins: pythonClient
      ? () => pythonClient.close()
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
