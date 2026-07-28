export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 20_000;
export const MAX_WEB_SEARCH_TIMEOUT_MS = 60_000;
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const MAX_WEB_SEARCH_RESULTS = 10;
export const DEFAULT_WEB_SEARCH_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_WEB_SEARCH_OUTPUT_BYTES = 256 * 1024;

export const webSearchPluginCatalogEntry = {
  plugin_id: "web-search",
  display_name: "Web search",
  description:
    "Search the public web through a cleaned, stateless Exa MCP integration.",
  default_enabled: false,
  configuration_fields: [
    {
      kind: "number",
      configuration_key: "timeout_seconds",
      display_name: "Search timeout",
      description: "Maximum runtime for one web search.",
      default_value: DEFAULT_WEB_SEARCH_TIMEOUT_MS / 1_000,
      minimum: 5,
      maximum: MAX_WEB_SEARCH_TIMEOUT_MS / 1_000,
      step: 1,
      suffix: "seconds",
    },
    {
      kind: "number",
      configuration_key: "maximum_results",
      display_name: "Maximum results",
      description: "Upper bound the agent may request per search.",
      default_value: DEFAULT_WEB_SEARCH_MAX_RESULTS,
      minimum: 1,
      maximum: MAX_WEB_SEARCH_RESULTS,
      step: 1,
      suffix: "results",
    },
    {
      kind: "number",
      configuration_key: "max_output_kib",
      display_name: "Maximum output",
      description: "Maximum search result text returned to the agent.",
      default_value: DEFAULT_WEB_SEARCH_MAX_OUTPUT_BYTES / 1_024,
      minimum: 16,
      maximum: MAX_WEB_SEARCH_OUTPUT_BYTES / 1_024,
      step: 16,
      suffix: "KiB",
    },
  ],
} as const;

export type WebSearchPluginRuntimeConfiguration = {
  enabled: boolean;
  timeout_ms: number;
  maximum_results: number;
  max_output_bytes: number;
};

type StoredPluginSetting = {
  enabled?: unknown;
  configuration?: unknown;
};

export function resolveWebSearchPluginRuntimeConfiguration(
  setting: StoredPluginSetting | null | undefined,
): WebSearchPluginRuntimeConfiguration {
  const configuration = isRecord(setting?.configuration)
    ? setting.configuration
    : {};
  return {
    enabled: setting?.enabled === true,
    timeout_ms: boundedInteger(
      configuration.timeout_seconds,
      DEFAULT_WEB_SEARCH_TIMEOUT_MS / 1_000,
      5,
      MAX_WEB_SEARCH_TIMEOUT_MS / 1_000,
    ) * 1_000,
    maximum_results: boundedInteger(
      configuration.maximum_results,
      DEFAULT_WEB_SEARCH_MAX_RESULTS,
      1,
      MAX_WEB_SEARCH_RESULTS,
    ),
    max_output_bytes: boundedInteger(
      configuration.max_output_kib,
      DEFAULT_WEB_SEARCH_MAX_OUTPUT_BYTES / 1_024,
      16,
      MAX_WEB_SEARCH_OUTPUT_BYTES / 1_024,
    ) * 1_024,
  };
}

export function parseWebSearchPluginRuntimeConfiguration(
  value: unknown,
): WebSearchPluginRuntimeConfiguration {
  if (!isExactRecord(value, [
    "enabled",
    "timeout_ms",
    "maximum_results",
    "max_output_bytes",
  ]) || typeof value.enabled !== "boolean") {
    throw new Error("Invalid web search plugin configuration.");
  }
  return {
    enabled: value.enabled,
    timeout_ms: boundedInteger(
      value.timeout_ms,
      -1,
      5_000,
      MAX_WEB_SEARCH_TIMEOUT_MS,
    ),
    maximum_results: boundedInteger(
      value.maximum_results,
      -1,
      1,
      MAX_WEB_SEARCH_RESULTS,
    ),
    max_output_bytes: boundedInteger(
      value.max_output_bytes,
      -1,
      16 * 1_024,
      MAX_WEB_SEARCH_OUTPUT_BYTES,
    ),
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    if (fallback >= minimum && fallback <= maximum) return fallback;
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === fields.length &&
    fields.every((field) => field in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
