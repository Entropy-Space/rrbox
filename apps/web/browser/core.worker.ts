/// <reference lib="webworker" />

import { AgentCore } from "@researchbox/agent-core";
import {
  attachWorkerHost,
  WorkerModelTransport,
  type WorkerHost,
} from "@researchbox/runtime-browser";
import { createResearchBoxFileSystem } from "./seed-files";
import { researchBoxMockModel, researchBoxSystemPrompt } from "./mock-model";

const host = self as unknown as WorkerHost;
const llmWorker = new Worker(new URL("./llm.worker.ts", import.meta.url), {
  type: "module",
  name: "researchbox-llm",
});
const core = new AgentCore({
  workspace: createResearchBoxFileSystem(),
  modelTransport: new WorkerModelTransport(llmWorker),
  model: researchBoxMockModel,
  systemPrompt: researchBoxSystemPrompt,
  eventSink: (event) => host.postMessage(event),
});

attachWorkerHost(host, core);

export {};
