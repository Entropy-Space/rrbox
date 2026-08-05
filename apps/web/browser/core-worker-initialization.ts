import {
  parsePythonPluginRuntimeConfiguration,
  type PythonPluginRuntimeConfiguration,
} from "@researchbox/python-plugin/settings";
import {
  parseWebSearchPluginRuntimeConfiguration,
  type WebSearchPluginRuntimeConfiguration,
} from "@researchbox/web-search-plugin/settings";
import {
  parseProviderRuntimeConfiguration,
  type ProviderRuntimeConfiguration,
} from "@researchbox/provider-settings";

export const WEB_CORE_WORKER_PROTOCOL_VERSION = 6 as const;
export const WEB_LLM_WORKER_PROTOCOL_VERSION = 1 as const;

export type WebCoreWorkerInitializeMessage = {
  protocol_version: typeof WEB_CORE_WORKER_PROTOCOL_VERSION;
  kind: "web_core_initialize";
  providers: ProviderRuntimeConfiguration[];
  python_plugin: PythonPluginRuntimeConfiguration;
  web_search_plugin: WebSearchPluginRuntimeConfiguration;
};

export function parseWebCoreWorkerInitializeMessage(
  value: unknown,
): WebCoreWorkerInitializeMessage {
  if (!isRecord(value)) {
    throw new Error("Invalid web core worker initialization.");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== 5 ||
    !fields.includes("protocol_version") ||
    !fields.includes("kind") ||
    !fields.includes("providers") ||
    !fields.includes("python_plugin") ||
    !fields.includes("web_search_plugin") ||
    value.protocol_version !== WEB_CORE_WORKER_PROTOCOL_VERSION ||
    value.kind !== "web_core_initialize"
  ) {
    throw new Error("Invalid web core worker initialization.");
  }
  return {
    protocol_version: WEB_CORE_WORKER_PROTOCOL_VERSION,
    kind: "web_core_initialize",
    providers: parseProviderRuntimeConfigurations(value.providers),
    python_plugin: parsePythonPluginRuntimeConfiguration(
      value.python_plugin,
    ),
    web_search_plugin: parseWebSearchPluginRuntimeConfiguration(
      value.web_search_plugin,
    ),
  };
}

export type WebLlmWorkerInitializeMessage = {
  protocol_version: typeof WEB_LLM_WORKER_PROTOCOL_VERSION;
  kind: "web_llm_initialize";
  providers: ProviderRuntimeConfiguration[];
};

export function parseWebLlmWorkerInitializeMessage(
  value: unknown,
): WebLlmWorkerInitializeMessage {
  if (!isRecord(value)) {
    throw new Error("Invalid web LLM worker initialization.");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== 3 ||
    !fields.includes("protocol_version") ||
    !fields.includes("kind") ||
    !fields.includes("providers") ||
    value.protocol_version !== WEB_LLM_WORKER_PROTOCOL_VERSION ||
    value.kind !== "web_llm_initialize"
  ) {
    throw new Error("Invalid web LLM worker initialization.");
  }
  return {
    protocol_version: WEB_LLM_WORKER_PROTOCOL_VERSION,
    kind: "web_llm_initialize",
    providers: parseProviderRuntimeConfigurations(value.providers),
  };
}

function parseProviderRuntimeConfigurations(
  value: unknown,
): ProviderRuntimeConfiguration[] {
  if (!Array.isArray(value)) {
    throw new Error("Provider runtime configurations must be an array.");
  }
  const providers = value.map(parseProviderRuntimeConfiguration);
  const providerIds = new Set(
    providers.map((provider) => provider.provider_id),
  );
  if (providerIds.size !== providers.length) {
    throw new Error("Provider runtime configuration IDs must be unique.");
  }
  return providers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
