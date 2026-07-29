import type {
  WebSearchProviderId,
  WebSearchResolvedProviderId,
  WebSearchWorkflow,
} from "./web-search-plugin.ts";

export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 20_000;
export const MAX_WEB_SEARCH_TIMEOUT_MS = 60_000;
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
export const MAX_WEB_SEARCH_RESULTS = 20;
export const DEFAULT_WEB_SEARCH_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_WEB_SEARCH_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_WEB_SEARCH_PROVIDER = "auto" as const;
export const DEFAULT_WEB_SEARCH_WORKFLOW = "summary-review" as const;
export const DEFAULT_WEB_SEARCH_SUMMARY_TIMEOUT_MS = 30_000;
export const MAX_WEB_SEARCH_SUMMARY_TIMEOUT_MS = 60_000;
export const DEFAULT_WEB_SEARCH_REVIEW_TIMEOUT_MS = 20_000;
export const MAX_WEB_SEARCH_REVIEW_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_WEB_SEARCH_ROUTING_ORDER =
  "exa-anysearch" as const;

export type WebSearchRoutingOrder =
  | "exa-anysearch"
  | "anysearch-exa";

export function createWebSearchPluginCatalogEntry(options: {
  include_anysearch: boolean;
}) {
  const providerOptions = [
    { value: "auto", display_name: "Automatic" },
    { value: "all", display_name: "All eligible" },
    { value: "exa", display_name: "Exa" },
    ...(options.include_anysearch
      ? [{ value: "anysearch", display_name: "AnySearch" }]
      : []),
  ] as const;
  const routingFields = options.include_anysearch
    ? [{
        kind: "select" as const,
        configuration_key: "routing_order",
        display_name: "Automatic routing order",
        description:
          "Provider order used by Automatic before classified fallback.",
        default_value: DEFAULT_WEB_SEARCH_ROUTING_ORDER,
        options: [
          {
            value: "exa-anysearch",
            display_name: "Exa, then AnySearch",
          },
          {
            value: "anysearch-exa",
            display_name: "AnySearch, then Exa",
          },
        ],
      }] as const
    : [];
  return {
    plugin_id: "web-search",
    display_name: "Web search",
    description:
      "Search from one or several angles and synthesize cited findings.",
    default_enabled: false,
    configuration_fields: [
      {
        kind: "select",
        configuration_key: "provider",
        display_name: "Search provider",
        description:
          "Auto uses ordered fallback; All merges every available provider.",
        default_value: DEFAULT_WEB_SEARCH_PROVIDER,
        options: providerOptions,
      },
      ...routingFields,
      {
        kind: "select",
        configuration_key: "workflow",
        display_name: "Default workflow",
        description:
          "Synthesize results with the active model or return raw evidence.",
        default_value: DEFAULT_WEB_SEARCH_WORKFLOW,
        options: [
          {
            value: "summary-review",
            display_name: "Review summary",
          },
          {
            value: "auto-summary",
            display_name: "Automatic summary",
          },
          { value: "none", display_name: "Raw results" },
        ],
      },
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
        configuration_key: "summary_timeout_seconds",
        display_name: "Summary timeout",
        description: "Maximum runtime for the synthesis model.",
        default_value:
          DEFAULT_WEB_SEARCH_SUMMARY_TIMEOUT_MS / 1_000,
        minimum: 5,
        maximum: MAX_WEB_SEARCH_SUMMARY_TIMEOUT_MS / 1_000,
        step: 1,
        suffix: "seconds",
      },
      {
        kind: "number",
        configuration_key: "review_timeout_seconds",
        display_name: "Review deadline",
        description:
          "Auto-submit a deterministic summary if review remains unresolved.",
        default_value: DEFAULT_WEB_SEARCH_REVIEW_TIMEOUT_MS / 1_000,
        minimum: 5,
        maximum: MAX_WEB_SEARCH_REVIEW_TIMEOUT_MS / 1_000,
        step: 5,
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
}

export const webSearchPluginCatalogEntry =
  createWebSearchPluginCatalogEntry({
    include_anysearch: false,
  });

export const nativeWebSearchPluginCatalogEntry =
  createWebSearchPluginCatalogEntry({
    include_anysearch: true,
  });

export type WebSearchPluginRuntimeConfiguration = {
  enabled: boolean;
  provider: WebSearchProviderId;
  routing_order: WebSearchRoutingOrder;
  workflow: WebSearchWorkflow;
  timeout_ms: number;
  summary_timeout_ms: number;
  review_timeout_ms: number;
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
    provider: resolveProvider(configuration.provider),
    routing_order: resolveRoutingOrder(configuration.routing_order),
    workflow: resolveWorkflow(configuration.workflow),
    timeout_ms: boundedInteger(
      configuration.timeout_seconds,
      DEFAULT_WEB_SEARCH_TIMEOUT_MS / 1_000,
      5,
      MAX_WEB_SEARCH_TIMEOUT_MS / 1_000,
    ) * 1_000,
    summary_timeout_ms: boundedInteger(
      configuration.summary_timeout_seconds,
      DEFAULT_WEB_SEARCH_SUMMARY_TIMEOUT_MS / 1_000,
      5,
      MAX_WEB_SEARCH_SUMMARY_TIMEOUT_MS / 1_000,
    ) * 1_000,
    review_timeout_ms: boundedInteger(
      configuration.review_timeout_seconds,
      DEFAULT_WEB_SEARCH_REVIEW_TIMEOUT_MS / 1_000,
      5,
      MAX_WEB_SEARCH_REVIEW_TIMEOUT_MS / 1_000,
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
    "provider",
    "routing_order",
    "workflow",
    "timeout_ms",
    "summary_timeout_ms",
    "review_timeout_ms",
    "maximum_results",
    "max_output_bytes",
  ]) || typeof value.enabled !== "boolean") {
    throw new Error("Invalid web search plugin configuration.");
  }
  return {
    enabled: value.enabled,
    provider: parseProvider(value.provider),
    routing_order: parseRoutingOrder(value.routing_order),
    workflow: parseWorkflow(value.workflow),
    timeout_ms: boundedInteger(
      value.timeout_ms,
      -1,
      5_000,
      MAX_WEB_SEARCH_TIMEOUT_MS,
    ),
    summary_timeout_ms: boundedInteger(
      value.summary_timeout_ms,
      -1,
      5_000,
      MAX_WEB_SEARCH_SUMMARY_TIMEOUT_MS,
    ),
    review_timeout_ms: boundedInteger(
      value.review_timeout_ms,
      -1,
      5_000,
      MAX_WEB_SEARCH_REVIEW_TIMEOUT_MS,
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

function resolveProvider(value: unknown): WebSearchProviderId {
  return value === "all" || value === "exa" || value === "anysearch"
    ? value
    : DEFAULT_WEB_SEARCH_PROVIDER;
}

function parseProvider(value: unknown): WebSearchProviderId {
  if (
    value !== "auto" &&
    value !== "all" &&
    value !== "exa" &&
    value !== "anysearch"
  ) {
    throw new Error("Invalid web search provider.");
  }
  return value;
}

export function webSearchRoutingProviderIds(
  order: WebSearchRoutingOrder,
): readonly WebSearchResolvedProviderId[] {
  return order === "anysearch-exa"
    ? ["anysearch", "exa"]
    : ["exa", "anysearch"];
}

function resolveRoutingOrder(value: unknown): WebSearchRoutingOrder {
  return value === "anysearch-exa"
    ? value
    : DEFAULT_WEB_SEARCH_ROUTING_ORDER;
}

function parseRoutingOrder(value: unknown): WebSearchRoutingOrder {
  if (value !== "exa-anysearch" && value !== "anysearch-exa") {
    throw new Error("Invalid web search routing order.");
  }
  return value;
}

function resolveWorkflow(value: unknown): WebSearchWorkflow {
  return value === "none" || value === "auto-summary"
    ? value
    : DEFAULT_WEB_SEARCH_WORKFLOW;
}

function parseWorkflow(value: unknown): WebSearchWorkflow {
  if (
    value !== "none" &&
    value !== "auto-summary" &&
    value !== "summary-review"
  ) {
    throw new Error("Invalid web search workflow.");
  }
  return value;
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
