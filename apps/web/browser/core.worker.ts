/// <reference lib="webworker" />

import { AgentCore } from "@researchbox/agent-core";
import { HttpNdjsonModelTransport } from "@researchbox/model-transport";
import { attachWorkerHost, type WorkerHost } from "@researchbox/runtime-browser";
import { createResearchBoxFileSystem } from "./seed-files";
import { researchBoxMockModel, researchBoxSystemPrompt } from "./mock-model";

const host = self as unknown as WorkerHost;
const core = new AgentCore({
  workspace: createResearchBoxFileSystem(),
  modelTransport: new HttpNdjsonModelTransport("/api/mock"),
  model: researchBoxMockModel,
  systemPrompt: researchBoxSystemPrompt,
  eventSink: (event) => host.postMessage(event),
});

attachWorkerHost(host, core);

export {};
