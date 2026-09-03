import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_LOCAL_PROVIDER_ID,
  PROVIDER_SECRETS_STORAGE_KEY,
  PROVIDER_SETTINGS_STORAGE_KEY,
  defaultProviderSettings,
  emptyProviderSecrets,
  normalizeProviderBaseUrl,
  parseProviderSettingsDocument,
  parseProviderConfigurationInput,
  resolveProviderRuntimeConfigurations,
} from "../src/index.ts";
import {
  createBrowserProviderSettingsAdapter,
  loadBrowserProviderRuntimeConfigurations,
} from "../src/browser.ts";

test("default settings preserve the legacy local provider", () => {
  const settings = defaultProviderSettings();
  assert.equal(settings.providers[0].provider_id, LEGACY_LOCAL_PROVIDER_ID);
  assert.equal(settings.providers[0].base_url, "http://127.0.0.1:4141/v1");
});

test("manual effort options retain provider labels across save and reload and accept legacy IDs", async () => {
  const storage = memoryStorage();
  const adapter = createBrowserProviderSettingsAdapter({ storage });
  await adapter.save(configuration({ manual_models: [{
    model_id: "fixture-model", display_name: "Fixture model", context_window: null, max_output_tokens: null,
    supports_tools: true, supports_reasoning: true,
    reasoning_efforts: [
      { id: "ultra", display_name: "Think deeply", description: "Provider-defined budget." },
      "vendor:adaptive-v2",
    ],
  }] }));
  const snapshot = await createBrowserProviderSettingsAdapter({ storage }).load();
  assert.deepEqual(snapshot.providers.at(-1).manual_models[0].reasoning_efforts, [
    { id: "ultra", display_name: "Think deeply", description: "Provider-defined budget." },
    { id: "vendor:adaptive-v2", display_name: "Vendor:adaptive-v2" },
  ]);
});

test("browser settings remain safe to import and render without localStorage", async () => {
  const settings = loadBrowserProviderRuntimeConfigurations();
  assert.equal(settings[0].provider_id, LEGACY_LOCAL_PROVIDER_ID);

  const adapter = createBrowserProviderSettingsAdapter();
  const snapshot = await adapter.load();
  assert.equal(snapshot.providers[0].provider_id, LEGACY_LOCAL_PROVIDER_ID);
  await assert.rejects(
    adapter.save(configuration()),
    /Browser provider settings storage is unavailable/,
  );
});

test("browser settings keep public configuration and secrets separate", async () => {
  const storage = memoryStorage();
  const adapter = createBrowserProviderSettingsAdapter({ storage });
  await adapter.save(configuration({ api_key: "secret" }));

  const publicDocument = storage.read(PROVIDER_SETTINGS_STORAGE_KEY);
  const secretDocument = storage.read(PROVIDER_SECRETS_STORAGE_KEY);
  assert.equal(publicDocument.includes("secret"), false);
  assert.equal(secretDocument.includes("secret"), true);

  const snapshot = await adapter.load();
  assert.equal(snapshot.providers.at(-1).has_api_key, true);
  assert.equal("api_key" in snapshot.providers.at(-1), false);
  assert.equal(
    loadBrowserProviderRuntimeConfigurations(storage).at(-1).api_key,
    "secret",
  );
});

test("saving an empty key field preserves the existing key", async () => {
  const storage = memoryStorage();
  const adapter = createBrowserProviderSettingsAdapter({ storage });
  await adapter.save(configuration({ api_key: "secret" }));
  await adapter.save(configuration());
  assert.equal(
    loadBrowserProviderRuntimeConfigurations(storage).at(-1).api_key,
    "secret",
  );
});

test("provider test uses the saved key without exposing it", async () => {
  const storage = memoryStorage();
  const requests = [];
  const adapter = createBrowserProviderSettingsAdapter({
    storage,
    fetch_request: async (input, init) => {
      requests.push({ input: String(input), init });
      return new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
    },
  });
  await adapter.save(configuration({ api_key: "secret" }));
  const result = await adapter.test(configuration());
  assert.deepEqual(result.model_ids, ["model-a", "model-b"]);
  assert.equal(requests[0].init.headers.authorization, "Bearer secret");
});

test("runtime resolution excludes disabled providers", () => {
  const settings = parseProviderSettingsDocument({
    ...defaultProviderSettings(),
    providers: [configuration({ enabled: false })],
  });
  assert.deepEqual(
    resolveProviderRuntimeConfigurations(settings, emptyProviderSecrets()),
    [],
  );
});

test("base URL normalization rejects embedded credentials and query state", () => {
  assert.equal(
    normalizeProviderBaseUrl("https://example.com/v1/"),
    "https://example.com/v1",
  );
  assert.throws(
    () => normalizeProviderBaseUrl("https://user@example.com/v1"),
    /cannot contain credentials/,
  );
  assert.throws(
    () => normalizeProviderBaseUrl("https://example.com/v1?tenant=1"),
    /cannot contain credentials/,
  );
});

test("reserves the built-in mock provider identifier", () => {
  assert.throws(
    () => parseProviderConfigurationInput(configuration({ provider_id: "researchbox" })),
    /reserved/u,
  );
});

function configuration(overrides = {}) {
  return {
    provider_id: "provider-1",
    display_name: "Provider",
    preset_id: "custom",
    base_url: "https://example.com/v1",
    enabled: true,
    manual_models: [],
    send_reasoning_content: false,
    send_session_affinity_headers: false,
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    read(key) {
      return values.get(key);
    },
  };
}
