import {
  NATIVE_STORAGE_PROTOCOL_VERSION,
  type NativeStorageRequest,
  type NativeStorageResponse,
} from "@researchbox/storage-native";

export const NATIVE_CORE_WORKER_PROTOCOL_VERSION =
  NATIVE_STORAGE_PROTOCOL_VERSION;

export type NativeCoreWorkerInitializeMessage = {
  protocol_version: typeof NATIVE_CORE_WORKER_PROTOCOL_VERSION;
  kind: "native_core_initialize";
  storage_port: MessagePort;
};

export type NativeStorageCommand = (
  request: NativeStorageRequest,
) => Promise<NativeStorageResponse>;

export function parseNativeCoreWorkerInitializeMessage(
  value: unknown,
): NativeCoreWorkerInitializeMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    !("protocol_version" in value) ||
    value.protocol_version !== NATIVE_CORE_WORKER_PROTOCOL_VERSION ||
    !("kind" in value) ||
    value.kind !== "native_core_initialize" ||
    !("storage_port" in value) ||
    !isMessagePort(value.storage_port)
  ) {
    throw new Error("Invalid native core worker initialization.");
  }
  return value as NativeCoreWorkerInitializeMessage;
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
