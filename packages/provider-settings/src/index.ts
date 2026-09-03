import {
  parseUpstreamProviders,
  parseModelReasoningEfforts,
  type UpstreamProvider,
  type ModelReasoningEffortOption,
} from "@researchbox/model-transport";
import { EMBEDDED_TOKN_PROVIDER_ID, parseToknSettingsSnapshot, type ToknSettingsAdapter, type ToknSettingsSnapshot } from "./tokn.ts";
export * from "./tokn.ts";

export const PROVIDER_SETTINGS_FORMAT_VERSION = 1 as const;
export const PROVIDER_SECRETS_FORMAT_VERSION = 1 as const;
export const PROVIDER_SETTINGS_STORAGE_KEY =
  "researchbox:provider-settings:v1";
export const PROVIDER_SECRETS_STORAGE_KEY =
  "researchbox:provider-secrets:v1";
export const LEGACY_LOCAL_PROVIDER_ID = "local-openai";
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "researchbox",
]);

export type ProviderPresetId =
  | "local"
  | "openai"
  | "openrouter"
  | "deepseek"
  | "groq"
  | "together"
  | "custom";

export type ProviderPreset = {
  preset_id: ProviderPresetId;
  display_name: string;
  base_url: string;
  requires_api_key: boolean;
  send_reasoning_content: boolean;
  send_session_affinity_headers: boolean;
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    preset_id: "local",
    display_name: "Local OpenAI-compatible",
    base_url: "http://127.0.0.1:4141/v1",
    requires_api_key: false,
    send_reasoning_content: true,
    send_session_affinity_headers: true,
  },
  {
    preset_id: "openai",
    display_name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    requires_api_key: true,
    send_reasoning_content: false,
    send_session_affinity_headers: false,
  },
  {
    preset_id: "openrouter",
    display_name: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    requires_api_key: true,
    send_reasoning_content: true,
    send_session_affinity_headers: false,
  },
  {
    preset_id: "deepseek",
    display_name: "DeepSeek",
    base_url: "https://api.deepseek.com",
    requires_api_key: true,
    send_reasoning_content: true,
    send_session_affinity_headers: false,
  },
  {
    preset_id: "groq",
    display_name: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    requires_api_key: true,
    send_reasoning_content: true,
    send_session_affinity_headers: false,
  },
  {
    preset_id: "together",
    display_name: "Together AI",
    base_url: "https://api.together.ai/v1",
    requires_api_key: true,
    send_reasoning_content: true,
    send_session_affinity_headers: false,
  },
  {
    preset_id: "custom",
    display_name: "Custom",
    base_url: "",
    requires_api_key: false,
    send_reasoning_content: false,
    send_session_affinity_headers: false,
  },
] as const;

export type ProviderModelConfiguration = {
  model_id: string;
  display_name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_tools: boolean;
  supports_reasoning: boolean;
  reasoning_efforts: ModelReasoningEffortOption[];
};

export type ProviderStoredConfiguration = {
  backend?: "openai_compatible" | "tokn";
  upstream_providers?: UpstreamProvider[];
  provider_id: string;
  display_name: string;
  preset_id: ProviderPresetId;
  base_url: string;
  enabled: boolean;
  manual_models: ProviderModelConfiguration[];
  send_reasoning_content: boolean;
  send_session_affinity_headers: boolean;
};

export type ProviderPublicConfiguration =
  ProviderStoredConfiguration & {
    has_api_key: boolean;
  };

export type ProviderRuntimeConfiguration =
  ProviderStoredConfiguration & {
    api_key?: string;
  };

export type ProviderSettingsDocument = {
  format_version: typeof PROVIDER_SETTINGS_FORMAT_VERSION;
  providers: ProviderStoredConfiguration[];
};

export type ProviderSecretsDocument = {
  format_version: typeof PROVIDER_SECRETS_FORMAT_VERSION;
  api_keys: Record<string, string>;
};

export type ProviderSettingsSnapshot = {
  providers: ProviderPublicConfiguration[];
  embedded_tokn?: ToknSettingsSnapshot;
};

export type ProviderConfigurationInput =
  ProviderStoredConfiguration & {
    api_key?: string;
    remove_api_key?: boolean;
  };

export type ProviderTestResult = {
  model_ids: string[];
};

export type ProviderSettingsAdapter = {
  tokn?: ToknSettingsAdapter;
  load(): Promise<ProviderSettingsSnapshot>;
  save(
    input: ProviderConfigurationInput,
  ): Promise<ProviderSettingsSnapshot>;
  remove(provider_id: string): Promise<ProviderSettingsSnapshot>;
  test(input: ProviderConfigurationInput): Promise<ProviderTestResult>;
};

export function defaultProviderSettings(): ProviderSettingsDocument {
  return {
    format_version: PROVIDER_SETTINGS_FORMAT_VERSION,
    providers: [
      {
        provider_id: LEGACY_LOCAL_PROVIDER_ID,
        display_name: "OpenAI-compatible · localhost:4141",
        preset_id: "local",
        base_url: "http://127.0.0.1:4141/v1",
        enabled: true,
        manual_models: [],
        send_reasoning_content: true,
        send_session_affinity_headers: true,
      },
    ],
  };
}

export function emptyProviderSecrets(): ProviderSecretsDocument {
  return {
    format_version: PROVIDER_SECRETS_FORMAT_VERSION,
    api_keys: {},
  };
}

export function parseProviderSettingsDocument(
  value: unknown,
): ProviderSettingsDocument {
  const record = requireRecord(value, "Provider settings");
  if (record.format_version !== PROVIDER_SETTINGS_FORMAT_VERSION) {
    throw new Error("Unsupported provider settings format version.");
  }
  if (!Array.isArray(record.providers)) {
    throw new Error("Provider settings providers must be an array.");
  }
  const providers = record.providers.map(parseProviderStoredConfiguration);
  assertUniqueProviderIds(providers);
  return {
    format_version: PROVIDER_SETTINGS_FORMAT_VERSION,
    providers,
  };
}

export function parseProviderSecretsDocument(
  value: unknown,
): ProviderSecretsDocument {
  const record = requireRecord(value, "Provider secrets");
  if (record.format_version !== PROVIDER_SECRETS_FORMAT_VERSION) {
    throw new Error("Unsupported provider secrets format version.");
  }
  const rawKeys = requireRecord(record.api_keys, "Provider API keys");
  const apiKeys: Record<string, string> = {};
  for (const [providerId, candidate] of Object.entries(rawKeys)) {
    requireProviderId(providerId);
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error("Saved provider API keys must be non-empty strings.");
    }
    apiKeys[providerId] = candidate;
  }
  return {
    format_version: PROVIDER_SECRETS_FORMAT_VERSION,
    api_keys: apiKeys,
  };
}

export function parseProviderConfigurationInput(
  value: unknown,
): ProviderConfigurationInput {
  const record = requireRecord(value, "Provider configuration input");
  const stored = parseProviderStoredConfiguration(record);
  if (stored.backend === "tokn" || stored.provider_id === EMBEDDED_TOKN_PROVIDER_ID) {
    throw new Error("Use embedded tokn settings for the built-in provider.");
  }
  const apiKey = optionalString(record, "api_key");
  const removeApiKey = optionalBoolean(record, "remove_api_key") ?? false;
  if (apiKey !== undefined && removeApiKey) {
    throw new Error("A provider API key cannot be set and removed together.");
  }
  return {
    ...stored,
    ...(apiKey === undefined ? {} : { api_key: apiKey }),
    ...(removeApiKey ? { remove_api_key: true } : {}),
  };
}

export function parseProviderRuntimeConfiguration(
  value: unknown,
): ProviderRuntimeConfiguration {
  const record = requireRecord(value, "Provider runtime configuration");
  if (record.backend === "tokn") return parseProviderStoredConfiguration(record);
  const input = parseProviderConfigurationInput(value);
  if (input.remove_api_key) {
    throw new Error(
      "Runtime provider configuration cannot remove an API key.",
    );
  }
  return {
    provider_id: input.provider_id,
    display_name: input.display_name,
    preset_id: input.preset_id,
    base_url: input.base_url,
    enabled: input.enabled,
    manual_models: structuredClone(input.manual_models),
    send_reasoning_content: input.send_reasoning_content,
    send_session_affinity_headers:
      input.send_session_affinity_headers,
    ...(input.api_key === undefined ? {} : { api_key: input.api_key }),
  };
}

export function parseProviderSettingsSnapshot(
  value: unknown,
): ProviderSettingsSnapshot {
  const record = requireRecord(value, "Provider settings snapshot");
  if (!Array.isArray(record.providers)) {
    throw new Error("Provider settings snapshot providers must be an array.");
  }
  const providers = record.providers.map((candidate) => {
    const candidateRecord = requireRecord(
      candidate,
      "Public provider configuration",
    );
    return {
      ...parseProviderStoredConfiguration(candidateRecord),
      has_api_key: requireBoolean(candidateRecord, "has_api_key"),
    };
  });
  assertUniqueProviderIds(providers);
  return {
    providers,
    ...(record.embedded_tokn === undefined ? {} : {
      embedded_tokn: parseToknSettingsSnapshot(record.embedded_tokn),
    }),
  };
}

export function parseProviderTestResult(
  value: unknown,
): ProviderTestResult {
  const record = requireRecord(value, "Provider test result");
  if (!Array.isArray(record.model_ids)) {
    throw new Error("Provider test model_ids must be an array.");
  }
  const modelIds = record.model_ids.map((candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error("Provider test model_ids must be non-empty strings.");
    }
    return candidate;
  });
  if (new Set(modelIds).size !== modelIds.length) {
    throw new Error("Provider test model_ids must be unique.");
  }
  return { model_ids: modelIds };
}

export function createProviderSettingsSnapshot(
  settings: ProviderSettingsDocument,
  secrets: ProviderSecretsDocument,
): ProviderSettingsSnapshot {
  return {
    providers: settings.providers.map((provider) => ({
      ...structuredClone(provider),
      has_api_key: secrets.api_keys[provider.provider_id] !== undefined,
    })),
  };
}

export function publicProviderRuntimeConfiguration(
  provider: ProviderPublicConfiguration,
): ProviderRuntimeConfiguration {
  return {
    ...(provider.backend === undefined ? {} : { backend: provider.backend }),
    ...(provider.upstream_providers === undefined ? {} : {
      upstream_providers: structuredClone(provider.upstream_providers),
    }),
    provider_id: provider.provider_id,
    display_name: provider.display_name,
    preset_id: provider.preset_id,
    base_url: provider.base_url,
    enabled: provider.enabled,
    manual_models: structuredClone(provider.manual_models),
    send_reasoning_content: provider.send_reasoning_content,
    send_session_affinity_headers: provider.send_session_affinity_headers,
  };
}

export function resolveProviderRuntimeConfigurations(
  settings: ProviderSettingsDocument,
  secrets: ProviderSecretsDocument,
): ProviderRuntimeConfiguration[] {
  return settings.providers
    .filter((provider) => provider.enabled)
    .map((provider) => {
      const apiKey = secrets.api_keys[provider.provider_id];
      return {
        ...structuredClone(provider),
        ...(apiKey === undefined ? {} : { api_key: apiKey }),
      };
    });
}

export function upsertProviderConfiguration(
  settings: ProviderSettingsDocument,
  secrets: ProviderSecretsDocument,
  rawInput: ProviderConfigurationInput,
): {
  settings: ProviderSettingsDocument;
  secrets: ProviderSecretsDocument;
} {
  const input = parseProviderConfigurationInput(rawInput);
  const nextSettings = structuredClone(settings);
  const index = nextSettings.providers.findIndex(
    (provider) => provider.provider_id === input.provider_id,
  );
  const stored: ProviderStoredConfiguration = {
    provider_id: input.provider_id,
    display_name: input.display_name,
    preset_id: input.preset_id,
    base_url: input.base_url,
    enabled: input.enabled,
    manual_models: structuredClone(input.manual_models),
    send_reasoning_content: input.send_reasoning_content,
    send_session_affinity_headers:
      input.send_session_affinity_headers,
  };
  if (index === -1) nextSettings.providers.push(stored);
  else nextSettings.providers[index] = stored;
  assertUniqueProviderIds(nextSettings.providers);

  const nextSecrets = structuredClone(secrets);
  if (input.remove_api_key) {
    delete nextSecrets.api_keys[input.provider_id];
  } else if (input.api_key !== undefined) {
    nextSecrets.api_keys[input.provider_id] = input.api_key;
  }
  return { settings: nextSettings, secrets: nextSecrets };
}

export function removeProviderConfiguration(
  settings: ProviderSettingsDocument,
  secrets: ProviderSecretsDocument,
  providerId: string,
): {
  settings: ProviderSettingsDocument;
  secrets: ProviderSecretsDocument;
} {
  requireProviderId(providerId);
  const nextSettings = structuredClone(settings);
  nextSettings.providers = nextSettings.providers.filter(
    (provider) => provider.provider_id !== providerId,
  );
  const nextSecrets = structuredClone(secrets);
  delete nextSecrets.api_keys[providerId];
  return { settings: nextSettings, secrets: nextSecrets };
}

export function providerPreset(
  presetId: ProviderPresetId,
): ProviderPreset {
  const preset = PROVIDER_PRESETS.find(
    (candidate) => candidate.preset_id === presetId,
  );
  if (!preset) throw new Error(`Unknown provider preset: ${presetId}`);
  return preset;
}

export function normalizeProviderBaseUrl(value: string): string {
  const candidate = value.trim();
  if (candidate.length === 0) {
    throw new Error("Provider base URL is required.");
  }
  if (candidate.length > 2_048) {
    throw new Error("Provider base URL is too long.");
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Provider base URL must be a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Provider base URL must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Provider base URL cannot contain credentials, a query, or a fragment.",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

export function providerEndpoint(
  baseUrl: string,
  endpoint: "models" | "chat_completions",
): string {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  return `${normalized}/${
    endpoint === "models" ? "models" : "chat/completions"
  }`;
}

function parseProviderStoredConfiguration(
  value: unknown,
): ProviderStoredConfiguration {
  const record = requireRecord(value, "Provider configuration");
  if (record.backend !== undefined && record.backend !== "openai_compatible" && record.backend !== "tokn") {
    throw new Error("Unknown provider backend.");
  }
  const isTokn = record.backend === "tokn";
  if (isTokn && (record.provider_id !== EMBEDDED_TOKN_PROVIDER_ID || record.base_url !== "")) {
    throw new Error("Invalid embedded tokn provider.");
  }
  const presetId = requirePresetId(record.preset_id);
  const displayName = requireString(record, "display_name").trim();
  if (displayName.length === 0 || displayName.length > 80) {
    throw new Error("Provider display_name must contain 1 to 80 characters.");
  }
  if (!Array.isArray(record.manual_models)) {
    throw new Error("Provider manual_models must be an array.");
  }
  const manualModels = record.manual_models.map(parseProviderModel);
  const modelIds = new Set(manualModels.map((model) => model.model_id));
  if (modelIds.size !== manualModels.length) {
    throw new Error("Provider manual model IDs must be unique.");
  }
  return {
    provider_id: isTokn ? EMBEDDED_TOKN_PROVIDER_ID : requireProviderId(record.provider_id),
    ...(record.backend === undefined ? {} : { backend: record.backend }),
    ...(isTokn && record.upstream_providers !== undefined ? {
      upstream_providers: parseUpstreamProviders(record.upstream_providers),
    } : {}),
    display_name: displayName,
    preset_id: presetId,
    base_url: isTokn ? "" : normalizeProviderBaseUrl(requireString(record, "base_url")),
    enabled: requireBoolean(record, "enabled"),
    manual_models: manualModels,
    send_reasoning_content: requireBoolean(
      record,
      "send_reasoning_content",
    ),
    send_session_affinity_headers: requireBoolean(
      record,
      "send_session_affinity_headers",
    ),
  };
}

function parseProviderModel(value: unknown): ProviderModelConfiguration {
  const record = requireRecord(value, "Provider model configuration");
  const modelId = requireString(record, "model_id").trim();
  if (modelId.length === 0 || modelId.length > 256) {
    throw new Error("Provider model_id must contain 1 to 256 characters.");
  }
  const displayName = requireString(record, "display_name").trim();
  if (displayName.length === 0 || displayName.length > 256) {
    throw new Error(
      "Provider model display_name must contain 1 to 256 characters.",
    );
  }
  const supportsReasoning = requireBoolean(
    record,
    "supports_reasoning",
  );
  const reasoningEfforts = parseModelReasoningEfforts(record.reasoning_efforts);
  if (!supportsReasoning && reasoningEfforts.length > 0) {
    throw new Error(
      "A non-reasoning provider model cannot define reasoning efforts.",
    );
  }
  return {
    model_id: modelId,
    display_name: displayName,
    context_window: nullablePositiveInteger(record.context_window),
    max_output_tokens: nullablePositiveInteger(record.max_output_tokens),
    supports_tools: requireBoolean(record, "supports_tools"),
    supports_reasoning: supportsReasoning,
    reasoning_efforts: reasoningEfforts,
  };
}

function requirePresetId(value: unknown): ProviderPresetId {
  if (
    value !== "local" &&
    value !== "openai" &&
    value !== "openrouter" &&
    value !== "deepseek" &&
    value !== "groq" &&
    value !== "together" &&
    value !== "custom"
  ) {
    throw new Error("Invalid provider preset_id.");
  }
  return value;
}

function requireProviderId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    throw new Error("provider_id must be a valid non-empty identifier.");
  }
  if (RESERVED_PROVIDER_IDS.has(value)) {
    throw new Error(`provider_id is reserved: ${value}.`);
  }
  return value;
}

function assertUniqueProviderIds(
  providers: readonly ProviderStoredConfiguration[],
): void {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.provider_id)) {
      throw new Error(`Duplicate provider_id: ${provider.provider_id}`);
    }
    ids.add(provider.provider_id);
  }
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: Record<string, unknown>,
  field: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${field} must be a non-empty string when provided.`);
  }
  return candidate;
}

function requireBoolean(
  value: Record<string, unknown>,
  field: string,
): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return candidate;
}

function optionalBoolean(
  value: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "boolean") {
    throw new Error(`${field} must be a boolean when provided.`);
  }
  return candidate;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Provider model limits must be positive integers or null.");
  }
  return value as number;
}
