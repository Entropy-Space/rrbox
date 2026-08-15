import {
  createNativeUrlReaderErrorResponse,
  parseNativeUrlReaderRequest,
  type NativeUrlReaderOpenRequest,
  type NativeUrlReaderRequest,
} from "@researchbox/web-search-plugin/native-url-reader-protocol";
import { nativeUrlReaderCommands } from "./tauri.ts";
import type { NativeUrlReaderCommands } from "./types.ts";

export type NativeUrlReaderPortBroker = {
  close(): void;
};

export function createNativeUrlReaderPortBroker(
  port: MessagePort,
  commands: NativeUrlReaderCommands = nativeUrlReaderCommands,
): NativeUrlReaderPortBroker {
  const pendingRequestIds = new Set<string>();
  const activeRequests = new Map<string, NativeUrlReaderOpenRequest>();
  let closed = false;

  const postMessage = (message: unknown) => {
    if (!closed) port.postMessage(message);
  };

  const handleMessage = (event: MessageEvent<unknown>) => {
    let request: NativeUrlReaderRequest;
    try {
      request = parseNativeUrlReaderRequest(event.data);
    } catch (error) {
      const identity = readRequestIdentity(event.data);
      if (identity) {
        postMessage(createNativeUrlReaderErrorResponse(
          identity,
          "invalid_request",
          toErrorMessage(error, "The native URL reader request was invalid."),
        ));
      }
      return;
    }
    if (pendingRequestIds.has(request.request_id)) {
      postMessage(createNativeUrlReaderErrorResponse(
        request,
        "invalid_request",
        `Duplicate native URL reader request id: ${request.request_id}`,
      ));
      return;
    }
    pendingRequestIds.add(request.request_id);

    if (request.kind === "url_reader_open") {
      if (activeRequests.has(request.operation_id)) {
        pendingRequestIds.delete(request.request_id);
        postMessage(createNativeUrlReaderErrorResponse(
          request,
          "invalid_request",
          `URL reader operation is already active: ${request.operation_id}`,
        ));
        return;
      }
      activeRequests.set(request.operation_id, request);
      void commands.open(request).then(
        (response) => {
          pendingRequestIds.delete(request.request_id);
          activeRequests.delete(request.operation_id);
          postMessage(response);
        },
        (error: unknown) => {
          pendingRequestIds.delete(request.request_id);
          activeRequests.delete(request.operation_id);
          postMessage(createNativeUrlReaderErrorResponse(
            request,
            "internal",
            toErrorMessage(error, "The native URL reader failed."),
          ));
        },
      );
      return;
    }

    void commands.cancel(request).then(
      (response) => {
        pendingRequestIds.delete(request.request_id);
        postMessage(response);
      },
      (error: unknown) => {
        pendingRequestIds.delete(request.request_id);
        postMessage(createNativeUrlReaderErrorResponse(
          request,
          "internal",
          toErrorMessage(error, "The native URL reader cancellation failed."),
        ));
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
      for (const request of activeRequests.values()) {
        void commands.cancel({
          protocol_version: request.protocol_version,
          request_id: crypto.randomUUID(),
          operation_id: request.operation_id,
          kind: "url_reader_cancel",
        });
      }
      activeRequests.clear();
      pendingRequestIds.clear();
      port.close();
    },
  };
}

function readRequestIdentity(
  value: unknown,
): Pick<NativeUrlReaderRequest, "request_id" | "operation_id"> | null {
  if (!isRecord(value)) return null;
  const { request_id, operation_id } = value;
  if (
    typeof request_id !== "string" ||
    request_id.length === 0 ||
    typeof operation_id !== "string" ||
    operation_id.length === 0
  ) {
    return null;
  }
  return { request_id, operation_id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
