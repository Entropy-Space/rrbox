import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCatalogService } from "../src/provider-catalog-service.ts";
import { parseCoreEvent, PROTOCOL_VERSION } from "../../protocol/src/index.ts";
import { parseModelDescriptor } from "../../model-transport/src/model-transport.ts";

const defaultModel = {
  id: "researchbox-mock",
  name: "rrbox Mock",
  api: "openai-completions",
  provider: "researchbox",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const providerDefinitions = [
  {
    provider_id: "researchbox",
    display_name: "rrbox",
    kind: "mock",
    models: [defaultModel],
  },
  {
    provider_id: "local-openai",
    display_name: "Local OpenAI",
    kind: "openai_compatible",
    discover_models: true,
  },
];

test("Tokn identity and efforts survive discovery, runtime registration, and the UI protocol", async () => {
  const upstream_providers = [{ provider_id: "deepseek", display_name: "DeepSeek" }];
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: [{ provider_id: "builtin:tokn", display_name: "Tokn", kind: "tokn", upstream_providers, discover_models: true }],
    modelCatalog: { async listModels() { return [parseModelDescriptor({
      ...descriptor("deepseek/deepseek-v4-flash", true), provider_id: "builtin:tokn", upstream_provider_id: "deepseek",
      supports_reasoning: true, reasoning_efforts: ["none", "low", "high", "max"],
    })]; } },
  });
  assert.deepEqual(provider(catalog, "builtin:tokn").upstream_providers, upstream_providers);
  await catalog.startRefreshes();
  const tokn = provider(catalog, "builtin:tokn");
  const event = {
    protocol_version: PROTOCOL_VERSION, event_id: "tokn-catalog", type: "provider_catalog_snapshot",
    payload: catalog.snapshot(),
  };
  assert.deepEqual(parseCoreEvent(event), event);
  const invalid = structuredClone(event);
  invalid.payload.providers[0].models[0].provider_id = "deepseek";
  assert.throws(() => parseCoreEvent(invalid), /does not match/);
  assert.equal(tokn.kind, "tokn");
  assert.equal(tokn.models[0].upstream_provider_id, "deepseek");
  assert.deepEqual(tokn.models[0].reasoning_efforts, ["none", "low", "high", "max"]);
  catalog.close();
});

test("provider discovery starts independently and coalesces its first refresh", async () => {
  let discoveryCalls = 0;
  let releaseDiscovery;
  const discovery = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: providerDefinitions,
    modelCatalog: {
      async listModels() {
        discoveryCalls += 1;
        return discovery;
      },
    },
  });
  const snapshots = [];
  catalog.subscribe((snapshot) => snapshots.push(snapshot), true);

  catalog.startRefreshes();
  const joinedRefresh = catalog.refreshProvider("local-openai");
  assert.equal(discoveryCalls, 1);
  assert.equal(provider(catalog, "local-openai").availability, "loading");

  releaseDiscovery([descriptor("tool-model", true), descriptor("text-only", false)]);
  await joinedRefresh;

  const localProvider = provider(catalog, "local-openai");
  assert.equal(localProvider.availability, "ready");
  assert.equal(model(localProvider, "tool-model").availability, "ready");
  assert.equal(model(localProvider, "text-only").availability, "unavailable");
  assert.ok(snapshots.at(-1).catalog_revision > snapshots[0].catalog_revision);
});

test("preserves reasoning-effort support independently from reasoning", async () => {
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: providerDefinitions,
    modelCatalog: {
      async listModels() {
        return [
          {
            ...descriptor("reasoning-only", true),
            supports_reasoning: true,
          },
          {
            ...descriptor("reasoning-effort", true),
            supports_reasoning: true,
            supports_reasoning_effort: true,
          },
        ];
      },
    },
  });

  await catalog.refreshProvider("local-openai", { force: true });

  const reasoningOnly = catalog.getModel({
    provider_id: "local-openai",
    model_id: "reasoning-only",
  });
  const reasoningEffort = catalog.getModel({
    provider_id: "local-openai",
    model_id: "reasoning-effort",
  });
  assert.equal(reasoningOnly?.reasoning, true);
  assert.equal(reasoningOnly?.supports_reasoning_effort, false);
  assert.equal(reasoningEffort?.reasoning, true);
  assert.equal(reasoningEffort?.supports_reasoning_effort, true);
});

test("keeps manually configured non-tool models unavailable", () => {
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: [{
      provider_id: "researchbox",
      display_name: "rrbox",
      kind: "mock",
      models: [defaultModel],
    }, {
      provider_id: "manual",
      display_name: "Manual",
      kind: "openai_compatible",
      models: [{
        ...defaultModel,
        id: "text-only",
        provider: "manual",
        supports_tools: false,
      }],
    }],
  });

  const configured = model(provider(catalog, "manual"), "text-only");
  assert.equal(configured.availability, "unavailable");
  assert.match(configured.status_message, /does not support/u);
});

test("forced refreshes expose failures and recover without changing providers", async () => {
  let failure = new Error("gateway offline");
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: providerDefinitions,
    modelCatalog: {
      async listModels() {
        if (failure) throw failure;
        return [descriptor("tool-model", true)];
      },
    },
  });

  await catalog.refreshProvider("local-openai", { force: true });
  assert.equal(provider(catalog, "local-openai").availability, "unavailable");
  assert.match(
    provider(catalog, "local-openai").status_message,
    /gateway offline/,
  );

  failure = null;
  await catalog.refreshProvider("local-openai", { force: true });
  assert.equal(provider(catalog, "local-openai").availability, "ready");
  assert.equal(model(provider(catalog, "local-openai"), "tool-model").availability, "ready");
});

test("persisted missing selections remain unavailable until discovery returns them", async () => {
  let models = [];
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: providerDefinitions,
    modelCatalog: {
      async listModels() {
        return models;
      },
    },
  });
  const selection = {
    provider_id: "local-openai",
    model_id: "saved-model",
  };

  catalog.setPersistedSelections([selection]);
  assert.equal(
    model(provider(catalog, "local-openai"), "saved-model").availability,
    "unavailable",
  );
  assert.equal(catalog.isModelReady(selection), false);

  models = [descriptor("saved-model", true)];
  await catalog.refreshProvider("local-openai", { force: true });
  assert.equal(catalog.isModelReady(selection), true);

  catalog.setPersistedSelections([]);
  models = [];
  await catalog.refreshProvider("local-openai", { force: true });
  assert.equal(
    provider(catalog, "local-openai").models.some(
      (candidate) => candidate.model_id === "saved-model",
    ),
    false,
  );
});

test("catalog listeners cannot break successful discovery", async () => {
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: providerDefinitions,
    modelCatalog: {
      async listModels() {
        return [descriptor("tool-model", true)];
      },
    },
  });
  catalog.subscribe(() => {
    throw new Error("listener failed");
  });

  await catalog.refreshProvider("local-openai", { force: true });
  assert.equal(provider(catalog, "local-openai").availability, "ready");
});

test("an aborted refresh waiter does not release the shared refresh", async () => {
  let discoveryCalls = 0;
  let releaseDiscovery;
  const discovery = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: providerDefinitions,
    modelCatalog: {
      async listModels() {
        discoveryCalls += 1;
        return discovery;
      },
    },
  });
  const controller = new AbortController();

  const firstWaiter = catalog.refreshProvider("local-openai", {
    force: true,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(firstWaiter, { name: "AbortError" });

  const joinedWaiter = catalog.refreshProvider("local-openai", {
    force: true,
  });
  assert.equal(discoveryCalls, 1);
  releaseDiscovery([descriptor("coalesced-model", true)]);
  await joinedWaiter;

  assert.equal(
    model(provider(catalog, "local-openai"), "coalesced-model").availability,
    "ready",
  );
});

test("transport failure marks affected providers unavailable", () => {
  const catalog = new ProviderCatalogService({
    model: defaultModel,
    providers: providerDefinitions,
  });

  catalog.markProvidersUnavailable(
    ["researchbox", "local-openai"],
    "The LLM worker stopped unexpectedly.",
  );

  assert.equal(provider(catalog, "researchbox").availability, "unavailable");
  assert.equal(provider(catalog, "local-openai").availability, "unavailable");
  assert.equal(
    catalog.isModelReady({
      provider_id: "researchbox",
      model_id: "researchbox-mock",
    }),
    false,
  );
});

function provider(catalog, providerId) {
  const result = catalog
    .snapshot()
    .providers.find((candidate) => candidate.provider_id === providerId);
  assert.ok(result, `Missing provider ${providerId}`);
  return result;
}

function model(providerSummary, modelId) {
  const result = providerSummary.models.find(
    (candidate) => candidate.model_id === modelId,
  );
  assert.ok(result, `Missing model ${modelId}`);
  return result;
}

function descriptor(modelId, supportsTools) {
  return {
    provider_id: "local-openai",
    provider_display_name: "Local OpenAI",
    model_id: modelId,
    display_name: modelId,
    context_window: 128_000,
    max_output_tokens: 8_192,
    supports_tools: supportsTools,
    supports_reasoning: false,
  };
}
