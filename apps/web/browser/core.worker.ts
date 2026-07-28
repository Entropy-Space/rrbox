/// <reference lib="webworker" />

import {
  createResearchBoxProviderDefinitions,
  startResearchBoxCoreWorker,
} from "@researchbox/app-runtime-browser/core-worker";
import type { WorkerHost } from "@researchbox/runtime-browser";

const host = self as unknown as WorkerHost;

startResearchBoxCoreWorker({
  host,
  lock_manager: navigator.locks,
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

export {};
