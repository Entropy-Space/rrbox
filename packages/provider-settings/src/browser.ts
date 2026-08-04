import {
  PROVIDER_SECRETS_STORAGE_KEY,
  PROVIDER_SETTINGS_STORAGE_KEY,
  createProviderSettingsSnapshot,
  defaultProviderSettings,
  emptyProviderSecrets,
  normalizeProviderBaseUrl,
  parseProviderConfigurationInput,
  parseProviderSecretsDocument,
  parseProviderSettingsDocument,
  providerEndpoint,
  removeProviderConfiguration,
  resolveProviderRuntimeConfigurations,
  upsertProviderConfiguration,
  type ProviderConfigurationInput,
  type ProviderRuntimeConfiguration,
  type ProviderSecretsDocument,
  type ProviderSettingsAdapter,
  type ProviderSettingsDocument,
  type ProviderSettingsSnapshot,
  type ProviderTestResult,
} from "./index.ts";

export type ProviderSettingsStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function loadBrowserProviderSettings(
  storage: ProviderSettingsStorage = localStorage,
): ProviderSettingsDocument {
  return loadDocument(
    storage,
    PROVIDER_SETTINGS_STORAGE_KEY,
    defaultProviderSettings,
    parseProviderSettingsDocument,
  );
}

export function loadBrowserProviderSecrets(
  storage: ProviderSettingsStorage = localStorage,
): ProviderSecretsDocument {
  return loadDocument(
    storage,
    PROVIDER_SECRETS_STORAGE_KEY,
    emptyProviderSecrets,
    parseProviderSecretsDocument,
  );
}

export function loadBrowserProviderRuntimeConfigurations(
  storage: ProviderSettingsStorage = localStorage,
): ProviderRuntimeConfiguration[] {
  return resolveProviderRuntimeConfigurations(
    loadBrowserProviderSettings(storage),
    loadBrowserProviderSecrets(storage),
  );
}

export function createBrowserProviderSettingsAdapter(options: {
  storage?: ProviderSettingsStorage;
  fetch_request?: typeof fetch;
} = {}): ProviderSettingsAdapter {
  const storage = options.storage ?? localStorage;
  const fetchRequest = (options.fetch_request ?? fetch).bind(globalThis);

  return {
    async load() {
      return snapshot(storage);
    },
    async save(rawInput) {
      const input = parseProviderConfigurationInput(rawInput);
      const next = upsertProviderConfiguration(
        loadBrowserProviderSettings(storage),
        loadBrowserProviderSecrets(storage),
        input,
      );
      persist(storage, next.settings, next.secrets);
      return createProviderSettingsSnapshot(next.settings, next.secrets);
    },
    async remove(providerId) {
      const next = removeProviderConfiguration(
        loadBrowserProviderSettings(storage),
        loadBrowserProviderSecrets(storage),
        providerId,
      );
      persist(storage, next.settings, next.secrets);
      return createProviderSettingsSnapshot(next.settings, next.secrets);
    },
    async test(rawInput) {
      const input = parseProviderConfigurationInput(rawInput);
      const savedSecrets = loadBrowserProviderSecrets(storage);
      const apiKey = input.remove_api_key
        ? undefined
        : input.api_key ?? savedSecrets.api_keys[input.provider_id];
      return testProvider(input, apiKey, fetchRequest);
    },
  };
}

async function testProvider(
  input: ProviderConfigurationInput,
  apiKey: string | undefined,
  fetchRequest: typeof fetch,
): Promise<ProviderTestResult> {
  const baseUrl = normalizeProviderBaseUrl(input.base_url);
  let response: Response;
  try {
    response = await fetchRequest(providerEndpoint(baseUrl, "models"), {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(apiKey === undefined
          ? {}
          : { authorization: `Bearer ${apiKey}` }),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `Provider connection failed. The endpoint may be unavailable or may not allow browser CORS: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Models endpoint returned ${response.status}${
        detail ? `: ${detail.slice(0, 500)}` : "."
      }`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Models endpoint returned malformed JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Models endpoint response must contain a data array.");
  }
  const modelIds = payload.data.map((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id) {
      throw new Error(`Models endpoint data[${index}].id must be a non-empty string.`);
    }
    return candidate.id;
  });
  return { model_ids: [...new Set(modelIds)].sort() };
}

function snapshot(storage: ProviderSettingsStorage): ProviderSettingsSnapshot {
  return createProviderSettingsSnapshot(
    loadBrowserProviderSettings(storage),
    loadBrowserProviderSecrets(storage),
  );
}

function persist(
  storage: ProviderSettingsStorage,
  settings: ProviderSettingsDocument,
  secrets: ProviderSecretsDocument,
): void {
  storage.setItem(PROVIDER_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  if (Object.keys(secrets.api_keys).length === 0) {
    storage.removeItem(PROVIDER_SECRETS_STORAGE_KEY);
  } else {
    storage.setItem(PROVIDER_SECRETS_STORAGE_KEY, JSON.stringify(secrets));
  }
}

function loadDocument<T>(
  storage: ProviderSettingsStorage,
  key: string,
  fallback: () => T,
  parse: (value: unknown) => T,
): T {
  try {
    const serialized = storage.getItem(key);
    return serialized === null ? fallback() : parse(JSON.parse(serialized));
  } catch {
    return fallback();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
