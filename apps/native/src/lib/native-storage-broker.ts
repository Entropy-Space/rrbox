import {
  createNativeStorageErrorResponse,
  parseNativeStorageRequest,
  type NativeStorageRequest,
} from "@researchbox/storage-native";
import { invokeNativeStorageRequest } from "./tauri.ts";
import type { NativeStorageCommand } from "./types.ts";

export type NativeStoragePortBroker = {
  close(): void;
};

export function createNativeStoragePortBroker(
  port: MessagePort,
  command: NativeStorageCommand = invokeNativeStorageRequest,
): NativeStoragePortBroker {
  let closed = false;

  const handleMessage = (event: MessageEvent<unknown>) => {
    let request: NativeStorageRequest;
    try {
      request = parseNativeStorageRequest(event.data);
    } catch (error) {
      const requestId = readRequestId(event.data);
      if (requestId !== null) {
        port.postMessage(
          createNativeStorageErrorResponse(requestId, {
            code: "invalid_request",
            message: toErrorMessage(
              error,
              "The native storage request was invalid.",
            ),
          }),
        );
      }
      return;
    }

    void command(request).then(
      (response) => {
        if (!closed) port.postMessage(response);
      },
      (error: unknown) => {
        if (closed) return;
        port.postMessage(
          createNativeStorageErrorResponse(request.request_id, {
            code: "internal",
            message: toErrorMessage(
              error,
              "The native storage command failed.",
            ),
          }),
        );
      },
    );
  };

  port.addEventListener("message", handleMessage);
  port.start();

  return {
    close() {
      if (closed) return;
      closed = true;
      port.removeEventListener("message", handleMessage);
      port.close();
    },
  };
}

function readRequestId(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("request_id" in value) ||
    typeof value.request_id !== "string" ||
    value.request_id.length === 0
  ) {
    return null;
  }
  return value.request_id;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
