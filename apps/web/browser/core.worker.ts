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

const host = self as unknown as WorkerHost;
const pythonExecutor = new BrowserPythonExecutor({
  createWorker() {
    return new Worker(new URL("./python.worker.ts", import.meta.url), {
      type: "module",
      name: "researchbox-python",
    });
  },
});

startResearchBoxCoreWorker({
  host,
  lock_manager: navigator.locks,
  plugins: [createPythonAgentPlugin(pythonExecutor)],
  close_plugins() {
    pythonExecutor.close();
  },
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
