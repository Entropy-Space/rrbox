/// <reference lib="webworker" />

import { ResearchBoxCore } from "@researchbox/agent-core";
import {
  attachWorkerHost,
  WorkerModelTransport,
  type WorkerHost,
} from "@researchbox/runtime-browser";
import {
  IndexedDbProjectFileSystemProvider,
  IndexedDbProjectStore,
  ResearchBoxDatabase,
} from "./persistence";
import { researchBoxSeedFiles } from "./seed-files";
import { researchBoxMockModel, researchBoxSystemPrompt } from "./mock-model";
import {
  queueMessagesUntilStarted,
  withExclusiveWriterLease,
} from "./writer-lease";

const host = self as unknown as WorkerHost;
const workerLifetime = new Promise<void>(() => undefined);
const drainQueuedMessages = queueMessagesUntilStarted(host);

void withExclusiveWriterLease(navigator.locks, async () => {
  const llmWorker = new Worker(new URL("./llm.worker.ts", import.meta.url), {
    type: "module",
    name: "researchbox-llm",
  });
  const database = new ResearchBoxDatabase();
  const modelGateway = new WorkerModelTransport(llmWorker);
  const core = new ResearchBoxCore({
    projectStore: new IndexedDbProjectStore(database),
    workspaceProvider: new IndexedDbProjectFileSystemProvider(
      database,
      researchBoxSeedFiles,
    ),
    modelTransport: modelGateway,
    modelCatalog: modelGateway,
    model: researchBoxMockModel,
    providers: [
      {
        provider_id: researchBoxMockModel.provider,
        display_name: "ResearchBox",
        kind: "mock",
        models: [researchBoxMockModel],
      },
      {
        provider_id: "local-openai",
        display_name: "OpenAI-compatible · localhost:4141",
        kind: "openai_compatible",
        discover_models: true,
      },
    ],
    systemPrompt: researchBoxSystemPrompt,
    eventSink: (event) => host.postMessage(event),
  });

  attachWorkerHost(host, core);
  drainQueuedMessages();
  await workerLifetime;
});

export {};
