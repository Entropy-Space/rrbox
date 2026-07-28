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

export const NATIVE_CORE_WORKER_PROTOCOL_VERSION = 2 as const;
export const NATIVE_LLM_WORKER_PROTOCOL_VERSION = 1 as const;

export type NativeCoreWorkerInitializeMessage = {
  protocol_version: typeof NATIVE_CORE_WORKER_PROTOCOL_VERSION;
  kind: "native_core_initialize";
  storage_port: MessagePort;
  provider_port: MessagePort;
};

export type NativeLlmWorkerInitializeMessage = {
  protocol_version: typeof NATIVE_LLM_WORKER_PROTOCOL_VERSION;
  kind: "native_llm_initialize";
  provider_port: MessagePort;
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

export function parseNativeCoreWorkerInitializeMessage(
  value: unknown,
): NativeCoreWorkerInitializeMessage {
  if (!isExactRecord(value, [
    "protocol_version",
    "kind",
    "storage_port",
    "provider_port",
  ])) {
    throw new Error("Invalid native core worker initialization.");
  }
  if (
    value.protocol_version !== NATIVE_CORE_WORKER_PROTOCOL_VERSION ||
    value.kind !== "native_core_initialize" ||
    !isMessagePort(value.storage_port) ||
    !isMessagePort(value.provider_port)
  ) {
    throw new Error("Invalid native core worker initialization.");
  }
  return value as NativeCoreWorkerInitializeMessage;
}

export function parseNativeLlmWorkerInitializeMessage(
  value: unknown,
): NativeLlmWorkerInitializeMessage {
  if (!isExactRecord(value, [
    "protocol_version",
    "kind",
    "provider_port",
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
  return value as NativeLlmWorkerInitializeMessage;
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
