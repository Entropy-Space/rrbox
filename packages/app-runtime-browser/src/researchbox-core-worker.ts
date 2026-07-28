import {
  ProviderCatalogService,
  ResearchBoxCore,
  type ModelProviderDefinition,
} from "@researchbox/agent-core";
import {
  attachCoreWorkerLifecycle,
  WorkerModelTransport,
  type WorkerHost,
} from "@researchbox/runtime-browser";
import {
  BrowserWorkspaceBackend,
  IndexedDbProjectStore,
  ResearchBoxDatabase,
} from "@researchbox/storage-browser";
import type { ProjectStore } from "@researchbox/project-store";
import type { WorkspaceBackend } from "@researchbox/vfs";
import {
  startBrowserRuntime,
  type BrowserRuntimeHandle,
} from "./browser-runtime.ts";
import type { CommandLockManager } from "./command-coordinator.ts";
import {
  researchBoxMockModel,
  researchBoxSystemPrompt,
} from "./mock-model.ts";
import { researchBoxSeedFiles } from "./seed-files.ts";
import { BROWSER_WORKSPACE_ARCHIVE_OPTIONS } from "./workspace-transfer-limits.ts";

export type ResearchBoxCoreWorkerOptions = {
  host: WorkerHost;
  lock_manager: CommandLockManager;
  create_model_worker(): Worker;
  create_storage_services?(): ResearchBoxStorageServices;
  providers: ModelProviderDefinition[];
};

export type ResearchBoxStorageServices = {
  projectStore: ProjectStore;
  workspaceBackend: WorkspaceBackend;
  close(): void | Promise<void>;
};

export function startResearchBoxCoreWorker(
  options: ResearchBoxCoreWorkerOptions,
): BrowserRuntimeHandle {
  const runtime = startBrowserRuntime({
    host: options.host,
    lockManager: options.lock_manager,
    createServices() {
      const storageServices =
        options.create_storage_services?.() ??
        createBrowserStorageServices();
      const modelWorker = options.create_model_worker();
      const modelGateway = new WorkerModelTransport(modelWorker);
      const providerCatalog = new ProviderCatalogService({
        model: researchBoxMockModel,
        providers: options.providers,
        modelCatalog: modelGateway,
      });
      const unsubscribeTransportFailure = modelGateway.subscribeFatalError(
        (error) => {
          providerCatalog.markProvidersUnavailable(
            options.providers.map((provider) => provider.provider_id),
            error.message,
          );
        },
      );

      return {
        providerCatalog,
        modelTransport: modelGateway,
        projectStore: storageServices.projectStore,
        workspaceBackend: storageServices.workspaceBackend,
        async close() {
          unsubscribeTransportFailure();
          try {
            await storageServices.close();
          } finally {
            providerCatalog.close();
            modelGateway.close();
          }
        },
      };
    },
    createCore(services, eventSink) {
      return new ResearchBoxCore({
        projectStore: services.projectStore,
        workspaceBackend: services.workspaceBackend,
        modelTransport: services.modelTransport,
        providerCatalog: services.providerCatalog,
        model: researchBoxMockModel,
        systemPrompt: researchBoxSystemPrompt,
        eventSink,
        workspaceTransferOptions: BROWSER_WORKSPACE_ARCHIVE_OPTIONS,
      });
    },
  });
  attachCoreWorkerLifecycle(options.host, () => runtime.dispose());
  return runtime;
}

function createBrowserStorageServices(): ResearchBoxStorageServices {
  const database = new ResearchBoxDatabase();
  const projectStore = new IndexedDbProjectStore(database);
  return {
    projectStore,
    workspaceBackend: new BrowserWorkspaceBackend(
      database,
      researchBoxSeedFiles,
    ),
    close() {
      projectStore.close();
      database.close();
    },
  };
}

export function createResearchBoxProviderDefinitions(options: {
  include_local_openai: boolean;
}): ModelProviderDefinition[] {
  const providers: ModelProviderDefinition[] = [
    {
      provider_id: researchBoxMockModel.provider,
      display_name: "ResearchBox",
      kind: "mock",
      models: [researchBoxMockModel],
    },
  ];

  if (options.include_local_openai) {
    providers.push({
      provider_id: "local-openai",
      display_name: "OpenAI-compatible · localhost:4141",
      kind: "openai_compatible",
      discover_models: true,
    });
  }

  return providers;
}
