import {
  parsePythonPluginRuntimeConfiguration,
  type PythonPluginRuntimeConfiguration,
} from "@researchbox/python-plugin/settings";
import {
  parseWebSearchPluginRuntimeConfiguration,
  type WebSearchPluginRuntimeConfiguration,
} from "@researchbox/web-search-plugin/settings";

export const WEB_CORE_WORKER_PROTOCOL_VERSION = 4 as const;

export type WebCoreWorkerInitializeMessage = {
  protocol_version: typeof WEB_CORE_WORKER_PROTOCOL_VERSION;
  kind: "web_core_initialize";
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
    fields.length !== 4 ||
    !fields.includes("protocol_version") ||
    !fields.includes("kind") ||
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
    python_plugin: parsePythonPluginRuntimeConfiguration(
      value.python_plugin,
    ),
    web_search_plugin: parseWebSearchPluginRuntimeConfiguration(
      value.web_search_plugin,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
