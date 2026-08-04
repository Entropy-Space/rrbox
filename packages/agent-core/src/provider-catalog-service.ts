import type { Model } from "@earendil-works/pi-ai";
import type { ModelDescriptor } from "@researchbox/model-transport";
import type {
  ModelSelection,
  ModelSummary,
  ProviderSummary,
} from "@researchbox/protocol";

export type ProviderModelCatalog = {
  listModels(
    providerId: string,
    signal: AbortSignal,
  ): Promise<ModelDescriptor[]>;
};

export type ProviderCatalogModel = Model<string> & {
  supports_reasoning_effort: boolean;
  reasoning_efforts: ModelSummary["reasoning_efforts"];
};

export type ProviderModelInput = Model<string> & {
  supports_tools?: boolean;
  supports_reasoning_effort?: boolean;
  reasoning_efforts?: ModelSummary["reasoning_efforts"];
};

export type ModelProviderDefinition = {
  provider_id: string;
  display_name: string;
  kind: ProviderSummary["kind"];
  models?: ProviderModelInput[];
  discover_models?: boolean;
};

export type ProviderCatalogSnapshot = {
  catalog_revision: number;
  providers: ProviderSummary[];
};

export type ProviderCatalogServiceOptions = {
  model: ProviderModelInput;
  providers?: ModelProviderDefinition[];
  modelCatalog?: ProviderModelCatalog;
};

type RegisteredModel = {
  model: ProviderCatalogModel;
  availability: ModelSummary["availability"];
  status_message?: string;
  is_persisted_placeholder: boolean;
};

type ProviderState = {
  provider_id: string;
  display_name: string;
  kind: ProviderSummary["kind"];
  availability: ProviderSummary["availability"];
  status_message?: string;
  discover_models: boolean;
  initial_refresh_started: boolean;
  is_configured: boolean;
  configured_models: Map<string, RegisteredModel>;
  models: Map<string, RegisteredModel>;
};

type CatalogListener = (snapshot: ProviderCatalogSnapshot) => void;

export class ProviderCatalogService {
  private readonly modelCatalog?: ProviderModelCatalog;
  private readonly providers = new Map<string, ProviderState>();
  private readonly persistedSelections = new Map<string, ModelSelection>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private readonly refreshControllers = new Map<string, AbortController>();
  private readonly listeners = new Set<CatalogListener>();
  private initialRefresh: Promise<void> | null = null;
  private catalogRevision = 0;
  private isClosed = false;

  constructor(options: ProviderCatalogServiceOptions) {
    this.modelCatalog = options.modelCatalog;
    this.initializeProviders(options.model, options.providers);
  }

  subscribe(listener: CatalogListener, emitCurrent = false): () => void {
    this.listeners.add(listener);
    if (emitCurrent) listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): ProviderCatalogSnapshot {
    return {
      catalog_revision: this.catalogRevision,
      providers: [...this.providers.values()].map(providerSummary),
    };
  }

  startRefreshes(): Promise<void> {
    this.assertOpen();
    if (this.initialRefresh) return this.initialRefresh;
    const refreshes = [...this.providers.values()]
      .filter(
        (provider) =>
          provider.discover_models && !provider.initial_refresh_started,
      )
      .map((provider) => this.refreshProvider(provider.provider_id));
    this.initialRefresh = Promise.all(refreshes).then(() => undefined);
    return this.initialRefresh;
  }

  async refreshProvider(
    providerId: string,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    this.assertOpen();
    if (options.signal?.aborted) throw createAbortError();
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error("The requested model provider is not configured.");
    }
    if (!provider.discover_models) return;

    const activeRefresh = this.refreshes.get(providerId);
    if (activeRefresh) {
      await waitForPromise(activeRefresh, options.signal);
      return;
    }
    if (provider.initial_refresh_started && !options.force) return;
    provider.initial_refresh_started = true;
    provider.availability = "loading";
    delete provider.status_message;
    this.publish();

    const controller = new AbortController();
    this.refreshControllers.set(providerId, controller);
    const refresh = this.runRefresh(provider, controller).finally(() => {
      if (this.refreshes.get(providerId) === refresh) {
        this.refreshes.delete(providerId);
      }
      if (this.refreshControllers.get(providerId) === controller) {
        this.refreshControllers.delete(providerId);
      }
    });
    this.refreshes.set(providerId, refresh);
    await waitForPromise(refresh, options.signal);
  }

  setPersistedSelections(selections: ModelSelection[]): void {
    this.assertOpen();
    this.persistedSelections.clear();
    for (const selection of selections) {
      const key = selectionKey(selection);
      this.persistedSelections.set(key, { ...selection });
    }
    let changed = this.removeUnusedPersistedPlaceholders();
    changed = this.ensurePersistedModelsRegistered() || changed;
    if (changed) this.publish();
  }

  hasProvider(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  isDiscoverable(providerId: string): boolean {
    return this.providers.get(providerId)?.discover_models ?? false;
  }

  isModelReady(selection: ModelSelection): boolean {
    const provider = this.providers.get(selection.provider_id);
    const model = provider?.models.get(selection.model_id);
    return (
      provider?.availability === "ready" && model?.availability === "ready"
    );
  }

  getModel(selection: ModelSelection): ProviderCatalogModel | undefined {
    return this.providers
      .get(selection.provider_id)
      ?.models.get(selection.model_id)?.model;
  }

  markProvidersUnavailable(
    providerIds: Iterable<string>,
    statusMessage: string,
  ): void {
    this.assertOpen();
    let changed = false;
    for (const providerId of providerIds) {
      const provider = this.providers.get(providerId);
      if (!provider) continue;
      if (
        provider.availability === "unavailable" &&
        provider.status_message === statusMessage
      ) {
        continue;
      }
      provider.availability = "unavailable";
      provider.status_message = statusMessage;
      changed = true;
    }
    if (changed) this.publish();
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const controller of this.refreshControllers.values()) {
      controller.abort();
    }
    this.refreshControllers.clear();
    this.listeners.clear();
  }

  private initializeProviders(
    defaultModel: ProviderModelInput,
    definitions: ModelProviderDefinition[] | undefined,
  ): void {
    const configured =
      definitions && definitions.length > 0
        ? definitions
        : [
            {
              provider_id: defaultModel.provider,
              display_name: defaultModel.provider,
              kind: "mock" as const,
              models: [defaultModel],
            },
          ];

    for (const definition of configured) {
      if (this.providers.has(definition.provider_id)) {
        throw new Error(`Duplicate model provider: ${definition.provider_id}`);
      }
      const configuredModels = new Map<string, RegisteredModel>();
      for (const candidate of definition.models ?? []) {
        const model = toProviderCatalogModel(candidate);
        const supportsTools = candidate.supports_tools ?? true;
        if (model.provider !== definition.provider_id) {
          throw new Error(
            `Model ${model.id} does not belong to provider ${definition.provider_id}.`,
          );
        }
        if (configuredModels.has(model.id)) {
          throw new Error(`Duplicate model id: ${model.id}`);
        }
        configuredModels.set(model.id, {
          model,
          availability: supportsTools ? "ready" : "unavailable",
          ...(supportsTools
            ? {}
            : {
                status_message:
                  "This model does not support the agent's tools.",
              }),
          is_persisted_placeholder: false,
        });
      }
      this.providers.set(definition.provider_id, {
        provider_id: definition.provider_id,
        display_name: definition.display_name,
        kind: definition.kind,
        availability:
          definition.discover_models && configuredModels.size === 0
            ? "loading"
            : "ready",
        discover_models: definition.discover_models ?? false,
        initial_refresh_started: false,
        is_configured: true,
        configured_models: cloneRegisteredModels(configuredModels),
        models: cloneRegisteredModels(configuredModels),
      });
    }

    let defaultProvider = this.providers.get(defaultModel.provider);
    if (!defaultProvider) {
      defaultProvider = {
        provider_id: defaultModel.provider,
        display_name: defaultModel.provider,
        kind: "mock",
        availability: "ready",
        discover_models: false,
        initial_refresh_started: false,
        is_configured: true,
        configured_models: new Map(),
        models: new Map(),
      };
      this.providers.set(defaultProvider.provider_id, defaultProvider);
    }
    const normalizedDefaultModel = toProviderCatalogModel(defaultModel);
    defaultProvider.models.set(normalizedDefaultModel.id, {
      model: normalizedDefaultModel,
      availability: "ready",
      is_persisted_placeholder: false,
    });
  }

  private async runRefresh(
    provider: ProviderState,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (!this.modelCatalog) {
        throw new Error("Model discovery is not configured.");
      }
      const descriptors = await this.modelCatalog.listModels(
        provider.provider_id,
        controller.signal,
      );
      if (this.isClosed || controller.signal.aborted) return;
      provider.models = mergeRegisteredModels(
        provider.configured_models,
        modelsFromDescriptors(provider.provider_id, descriptors),
      );
      provider.availability = "ready";
      delete provider.status_message;
      this.ensurePersistedModelsRegistered();
    } catch (error) {
      if (this.isClosed || controller.signal.aborted) return;
      const message = toErrorMessage(
        error,
        "The provider could not be reached.",
      );
      if (provider.configured_models.size > 0) {
        provider.models = cloneRegisteredModels(
          provider.configured_models,
        );
        provider.availability = "ready";
        provider.status_message =
          `Model discovery failed; configured models remain available. ${message}`;
      } else {
        provider.availability = "unavailable";
        provider.status_message = message;
      }
    } finally {
      if (!this.isClosed && !controller.signal.aborted) this.publish();
    }
  }

  private ensurePersistedModelsRegistered(): boolean {
    let changed = false;
    for (const selection of this.persistedSelections.values()) {
      let provider = this.providers.get(selection.provider_id);
      if (!provider) {
        provider = {
          provider_id: selection.provider_id,
          display_name: selection.provider_id,
          kind: "openai_compatible",
          availability: "unavailable",
          status_message: "This saved provider is no longer configured.",
          discover_models: false,
          initial_refresh_started: false,
          is_configured: false,
          configured_models: new Map(),
          models: new Map(),
        };
        this.providers.set(selection.provider_id, provider);
        changed = true;
      }
      if (provider.models.has(selection.model_id)) continue;
      provider.models.set(selection.model_id, {
        model: unavailableModel(selection),
        availability: "unavailable",
        status_message: "This saved model was not returned by the provider.",
        is_persisted_placeholder: true,
      });
      changed = true;
    }
    return changed;
  }

  private removeUnusedPersistedPlaceholders(): boolean {
    let changed = false;
    for (const [providerId, provider] of this.providers) {
      for (const [modelId, model] of provider.models) {
        if (!model.is_persisted_placeholder) continue;
        if (
          this.persistedSelections.has(
            selectionKey({ provider_id: providerId, model_id: modelId }),
          )
        ) {
          continue;
        }
        provider.models.delete(modelId);
        changed = true;
      }
      if (!provider.is_configured && provider.models.size === 0) {
        this.providers.delete(providerId);
        changed = true;
      }
    }
    return changed;
  }

  private publish(): void {
    this.catalogRevision += 1;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Catalog consumers are isolated from discovery and each other.
      }
    }
  }

  private assertOpen(): void {
    if (this.isClosed) throw new Error("The provider catalog is closed.");
  }
}

function providerSummary(provider: ProviderState): ProviderSummary {
  return {
    provider_id: provider.provider_id,
    display_name: provider.display_name,
    kind: provider.kind,
    availability: provider.availability,
    ...(provider.status_message === undefined
      ? {}
      : { status_message: provider.status_message }),
    models: [...provider.models.values()]
      .map(({ model, availability, status_message }) => ({
        provider_id: provider.provider_id,
        model_id: model.id,
        display_name: model.name,
        availability,
        reasoning_efforts: [...model.reasoning_efforts],
        ...(status_message === undefined ? {} : { status_message }),
      }))
      .sort((left, right) => left.display_name.localeCompare(right.display_name)),
  };
}

function modelsFromDescriptors(
  providerId: string,
  descriptors: ModelDescriptor[],
): Map<string, RegisteredModel> {
  const models = new Map<string, RegisteredModel>();
  for (const descriptor of descriptors) {
    if (descriptor.provider_id !== providerId) {
      throw new Error("Model discovery returned the wrong provider_id.");
    }
    if (models.has(descriptor.model_id)) {
      throw new Error(
        `Model discovery returned duplicate model_id: ${descriptor.model_id}`,
      );
    }
    models.set(descriptor.model_id, {
      model: modelFromDescriptor(descriptor),
      availability: descriptor.supports_tools ? "ready" : "unavailable",
      is_persisted_placeholder: false,
      ...(descriptor.supports_tools
        ? {}
        : { status_message: "This model does not support the agent's tools." }),
    });
  }
  return models;
}

function cloneRegisteredModels(
  source: Map<string, RegisteredModel>,
): Map<string, RegisteredModel> {
  return new Map(
    [...source].map(([modelId, registered]) => [
      modelId,
      cloneRegisteredModel(registered),
    ]),
  );
}

function mergeRegisteredModels(
  configured: Map<string, RegisteredModel>,
  discovered: Map<string, RegisteredModel>,
): Map<string, RegisteredModel> {
  const merged = cloneRegisteredModels(discovered);
  for (const [modelId, model] of configured) {
    merged.set(modelId, cloneRegisteredModel(model));
  }
  return merged;
}

function cloneRegisteredModel(model: RegisteredModel): RegisteredModel {
  return {
    ...model,
    model: {
      ...model.model,
      reasoning_efforts: [...model.model.reasoning_efforts],
    },
  };
}

function modelFromDescriptor(
  descriptor: ModelDescriptor,
): ProviderCatalogModel {
  const reasoningEfforts = descriptor.reasoning_efforts
    ? [...descriptor.reasoning_efforts]
    : descriptor.supports_reasoning_effort === true
      ? (["minimal", "low", "medium", "high", "xhigh"] as const)
      : [];
  return {
    id: descriptor.model_id,
    name: descriptor.display_name,
    api: "openai-completions",
    provider: descriptor.provider_id,
    baseUrl: "",
    reasoning: descriptor.supports_reasoning,
    supports_reasoning_effort: reasoningEfforts.length > 0,
    reasoning_efforts: [...reasoningEfforts],
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: descriptor.context_window ?? 128_000,
    maxTokens: descriptor.max_output_tokens ?? 8_192,
  };
}

function unavailableModel(selection: ModelSelection): ProviderCatalogModel {
  return {
    id: selection.model_id,
    name: selection.model_id,
    api: "openai-completions",
    provider: selection.provider_id,
    baseUrl: "",
    reasoning: false,
    supports_reasoning_effort: false,
    reasoning_efforts: [],
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function toProviderCatalogModel(
  model: ProviderModelInput,
): ProviderCatalogModel {
  const reasoningEfforts = model.reasoning_efforts
    ? [...model.reasoning_efforts]
    : model.supports_reasoning_effort === true
      ? ["minimal", "low", "medium", "high", "xhigh"] as const
      : [];
  return {
    ...model,
    supports_reasoning_effort: reasoningEfforts.length > 0,
    reasoning_efforts: [...reasoningEfforts],
  };
}

function selectionKey(selection: ModelSelection): string {
  return `${selection.provider_id}\u0000${selection.model_id}`;
}

function waitForPromise(
  promise: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function createAbortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
