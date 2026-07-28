/// <reference lib="webworker" />

import {
  createResearchBoxProviderDefinitions,
  startResearchBoxCoreWorker,
} from "@researchbox/app-runtime-browser/core-worker";
import {
  InMemoryCommandLockManager,
} from "@researchbox/app-runtime-browser/command-coordinator";
import type { WorkerHost } from "@researchbox/runtime-browser";

const host = self as unknown as WorkerHost;
const workerNavigator = navigator as WorkerNavigator & {
  locks?: LockManager;
};
// The current native app has one WebView. Older WKWebView releases do not
// expose Web Locks, so retain intra-worker serialization until native IPC owns
// coordination. This fallback must not be reused for a multi-window native app.
const lockManager =
  workerNavigator.locks ?? new InMemoryCommandLockManager();

startResearchBoxCoreWorker({
  host,
  lock_manager: lockManager,
  providers: createResearchBoxProviderDefinitions({
    include_local_openai: false,
  }),
  create_model_worker() {
    return new Worker(new URL("./llm.worker.ts", import.meta.url), {
      type: "module",
      name: "researchbox-llm",
    });
  },
});

export {};
