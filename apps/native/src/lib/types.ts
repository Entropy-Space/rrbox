import {
  type NativeStorageRequest,
  type NativeStorageResponse,
} from "@researchbox/storage-native";
import type {
  NativeProviderCancelRequest,
  NativeProviderCancelResponse,
  NativeProviderFetchRequest,
  NativeProviderFetchResponse,
} from "@researchbox/provider-native";
import type {
  PythonCancelRequest,
  PythonCancelResponse,
  PythonExecuteRequest,
  PythonExecuteResponse,
} from "@researchbox/python-plugin/protocol";
import {
  parsePythonPluginRuntimeConfiguration,
  type PythonPluginRuntimeConfiguration,
} from "@researchbox/python-plugin/settings";
import {
  parseWebSearchPluginRuntimeConfiguration,
  type WebSearchPluginRuntimeConfiguration,
} from "@researchbox/web-search-plugin/settings";
import type {
  NativeWebSearchCancelRequest,
  NativeWebSearchCancelResponse,
  NativeWebSearchExecuteRequest,
  NativeWebSearchExecuteResponse,
} from "@researchbox/web-search-plugin/native-protocol";
import {
  parseProviderRuntimeConfiguration,
  type ProviderRuntimeConfiguration,
} from "@researchbox/provider-settings";

export const NATIVE_CORE_WORKER_PROTOCOL_VERSION = 9 as const;
export const NATIVE_LLM_WORKER_PROTOCOL_VERSION = 2 as const;

export type NativeCoreWorkerInitializeMessage = {
  protocol_version: typeof NATIVE_CORE_WORKER_PROTOCOL_VERSION;
  kind: "native_core_initialize";
  providers: ProviderRuntimeConfiguration[];
  storage_port: MessagePort;
  provider_port: MessagePort;
  python_port: MessagePort;
  web_search_port: MessagePort;
  python_plugin: PythonPluginRuntimeConfiguration;
  web_search_plugin: WebSearchPluginRuntimeConfiguration;
};

export type NativeLlmWorkerInitializeMessage = {
  protocol_version: typeof NATIVE_LLM_WORKER_PROTOCOL_VERSION;
  kind: "native_llm_initialize";
  provider_port: MessagePort;
  providers: ProviderRuntimeConfiguration[];
};

export type NativeStorageCommand = (
  request: NativeStorageRequest,
) => Promise<NativeStorageResponse>;

export type NativeProviderCommands = {
  fetch(
    request: NativeProviderFetchRequest,
    onEvent: (event: unknown) => void,
  ): Promise<NativeProviderFetchResponse>;
  cancel(
    request: NativeProviderCancelRequest,
  ): Promise<NativeProviderCancelResponse>;
};

export type NativePythonCommands = {
  execute(
    request: PythonExecuteRequest,
  ): Promise<PythonExecuteResponse>;
  cancel(
    request: PythonCancelRequest,
  ): Promise<PythonCancelResponse>;
};

export type NativeWebSearchCommands = {
  execute(
    request: NativeWebSearchExecuteRequest,
  ): Promise<NativeWebSearchExecuteResponse>;
  cancel(
    request: NativeWebSearchCancelRequest,
  ): Promise<NativeWebSearchCancelResponse>;
};

export function parseNativeCoreWorkerInitializeMessage(
  value: unknown,
): NativeCoreWorkerInitializeMessage {
  if (!isExactRecord(value, [
    "protocol_version",
    "kind",
    "providers",
    "storage_port",
    "provider_port",
    "python_port",
    "web_search_port",
    "python_plugin",
    "web_search_plugin",
  ])) {
    throw new Error("Invalid native core worker initialization.");
  }
  if (
    value.protocol_version !== NATIVE_CORE_WORKER_PROTOCOL_VERSION ||
    value.kind !== "native_core_initialize" ||
    !isMessagePort(value.storage_port) ||
    !isMessagePort(value.provider_port) ||
    !isMessagePort(value.python_port) ||
    !isMessagePort(value.web_search_port)
  ) {
    throw new Error("Invalid native core worker initialization.");
  }
  return {
    protocol_version: NATIVE_CORE_WORKER_PROTOCOL_VERSION,
    kind: "native_core_initialize",
    providers: parseProviderRuntimeConfigurations(value.providers),
    storage_port: value.storage_port,
    provider_port: value.provider_port,
    python_port: value.python_port,
    web_search_port: value.web_search_port,
    python_plugin: parsePythonPluginRuntimeConfiguration(
      value.python_plugin,
    ),
    web_search_plugin: parseWebSearchPluginRuntimeConfiguration(
      value.web_search_plugin,
    ),
  };
}

export function parseNativeLlmWorkerInitializeMessage(
  value: unknown,
): NativeLlmWorkerInitializeMessage {
  if (!isExactRecord(value, [
    "protocol_version",
    "kind",
    "provider_port",
    "providers",
  ])) {
    throw new Error("Invalid native LLM worker initialization.");
  }
  if (
    value.protocol_version !== NATIVE_LLM_WORKER_PROTOCOL_VERSION ||
    value.kind !== "native_llm_initialize" ||
    !isMessagePort(value.provider_port)
  ) {
    throw new Error("Invalid native LLM worker initialization.");
  }
  return {
    protocol_version: NATIVE_LLM_WORKER_PROTOCOL_VERSION,
    kind: "native_llm_initialize",
    provider_port: value.provider_port,
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

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const actualFields = Object.keys(value);
  return (
    actualFields.length === fields.length &&
    fields.every((field) => field in value)
  );
}

function isMessagePort(value: unknown): value is MessagePort {
  return (
    typeof value === "object" &&
    value !== null &&
    "postMessage" in value &&
    typeof value.postMessage === "function" &&
    "start" in value &&
    typeof value.start === "function" &&
    "close" in value &&
    typeof value.close === "function"
  );
}
