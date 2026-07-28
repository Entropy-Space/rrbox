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
import { parseNativeCoreWorkerInitializeMessage } from "../lib/types.ts";

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

  startResearchBoxCoreWorker({
    host,
    lock_manager: lockManager,
    providers: createResearchBoxProviderDefinitions({
      include_local_openai: false,
    }),
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
      return new Worker(new URL("./llm.worker.ts", import.meta.url), {
        type: "module",
        name: "researchbox-llm",
      });
    },
  });
};

export {};
