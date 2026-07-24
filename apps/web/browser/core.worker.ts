/// <reference lib="webworker" />

import {
  ProviderCatalogService,
  ResearchBoxCore,
} from "@researchbox/agent-core";
import {
  WorkerModelTransport,
  type WorkerHost,
} from "@researchbox/runtime-browser";
import { startBrowserRuntime } from "./browser-runtime.ts";
import {
  BrowserWorkspaceBackend,
  IndexedDbProjectStore,
  ResearchBoxDatabase,
} from "./persistence";
import { researchBoxSeedFiles } from "./seed-files";
import { researchBoxMockModel, researchBoxSystemPrompt } from "./mock-model";

const host = self as unknown as WorkerHost;
const providers = [
  {
    provider_id: researchBoxMockModel.provider,
    display_name: "ResearchBox",
    kind: "mock" as const,
    models: [researchBoxMockModel],
  },
  {
    provider_id: "local-openai",
    display_name: "OpenAI-compatible · localhost:4141",
    kind: "openai_compatible" as const,
    discover_models: true,
  },
];

startBrowserRuntime({
  host,
  lockManager: navigator.locks,
  createServices() {
    const llmWorker = new Worker(new URL("./llm.worker.ts", import.meta.url), {
      type: "module",
      name: "researchbox-llm",
    });
    const modelGateway = new WorkerModelTransport(llmWorker);
    const providerCatalog = new ProviderCatalogService({
      model: researchBoxMockModel,
      providers,
      modelCatalog: modelGateway,
    });
    const unsubscribeTransportFailure = modelGateway.subscribeFatalError(
      (error) => {
        providerCatalog.markProvidersUnavailable(
          providers.map((provider) => provider.provider_id),
          error.message,
        );
      },
    );
    return {
      providerCatalog,
      modelTransport: modelGateway,
      close() {
        unsubscribeTransportFailure();
        providerCatalog.close();
        modelGateway.close();
      },
    };
  },
  createCore(services, eventSink) {
    const database = new ResearchBoxDatabase();
    return new ResearchBoxCore({
      projectStore: new IndexedDbProjectStore(database),
      workspaceBackend: new BrowserWorkspaceBackend(
        database,
        researchBoxSeedFiles,
      ),
      modelTransport: services.modelTransport,
      providerCatalog: services.providerCatalog,
      model: researchBoxMockModel,
      systemPrompt: researchBoxSystemPrompt,
      eventSink,
    });
  },
});

export {};
