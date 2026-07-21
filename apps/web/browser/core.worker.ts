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
  const core = new ResearchBoxCore({
    projectStore: new IndexedDbProjectStore(database),
    workspaceProvider: new IndexedDbProjectFileSystemProvider(
      database,
      researchBoxSeedFiles,
    ),
    modelTransport: new WorkerModelTransport(llmWorker),
    model: researchBoxMockModel,
    systemPrompt: researchBoxSystemPrompt,
    eventSink: (event) => host.postMessage(event),
  });

  attachWorkerHost(host, core);
  drainQueuedMessages();
  await workerLifetime;
});

export {};
