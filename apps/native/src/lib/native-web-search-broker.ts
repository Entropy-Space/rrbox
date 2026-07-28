import {
  createNativeWebSearchErrorResponse,
  parseNativeWebSearchRequest,
  type NativeWebSearchExecuteRequest,
  type NativeWebSearchRequest,
} from "@researchbox/web-search-plugin/native-protocol";
import { nativeWebSearchCommands } from "./tauri.ts";
import type { NativeWebSearchCommands } from "./types.ts";

export type NativeWebSearchPortBroker = {
  close(): void;
};

export function createNativeWebSearchPortBroker(
  port: MessagePort,
  commands: NativeWebSearchCommands = nativeWebSearchCommands,
): NativeWebSearchPortBroker {
  const pendingRequestIds = new Set<string>();
  const activeExecutions = new Map<
    string,
    NativeWebSearchExecuteRequest
  >();
  let closed = false;

  const postMessage = (message: unknown) => {
    if (!closed) port.postMessage(message);
  };

  const handleMessage = (event: MessageEvent<unknown>) => {
    let request: NativeWebSearchRequest;
    try {
      request = parseNativeWebSearchRequest(event.data);
    } catch (error) {
      const identity = readRequestIdentity(event.data);
      if (identity) {
        postMessage(
          createNativeWebSearchErrorResponse(
            identity,
            "invalid_request",
            toErrorMessage(
              error,
              "The native web search request was invalid.",
            ),
          ),
        );
      }
      return;
    }

    if (pendingRequestIds.has(request.request_id)) {
      postMessage(
        createNativeWebSearchErrorResponse(
          request,
          "invalid_request",
          `Duplicate native web search request id: ${request.request_id}`,
        ),
      );
      return;
    }
    pendingRequestIds.add(request.request_id);

    if (request.kind === "web_search_execute") {
      if (activeExecutions.has(request.operation_id)) {
        pendingRequestIds.delete(request.request_id);
        postMessage(
          createNativeWebSearchErrorResponse(
            request,
            "invalid_request",
            `Web search operation is already active: ${request.operation_id}`,
          ),
        );
        return;
      }
      activeExecutions.set(request.operation_id, request);
      void commands.execute(request).then(
        (response) => {
          pendingRequestIds.delete(request.request_id);
          activeExecutions.delete(request.operation_id);
          postMessage(response);
        },
        (error: unknown) => {
          pendingRequestIds.delete(request.request_id);
          activeExecutions.delete(request.operation_id);
          postMessage(
            createNativeWebSearchErrorResponse(
              request,
              "internal",
              toErrorMessage(
                error,
                "The native web search execution failed.",
              ),
            ),
          );
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
        postMessage(
          createNativeWebSearchErrorResponse(
            request,
            "internal",
            toErrorMessage(
              error,
              "The native web search cancellation failed.",
            ),
          ),
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
      for (const execution of activeExecutions.values()) {
        void commands.cancel({
          protocol_version: execution.protocol_version,
          request_id: crypto.randomUUID(),
          operation_id: execution.operation_id,
          kind: "web_search_cancel",
        });
      }
      activeExecutions.clear();
      pendingRequestIds.clear();
      port.close();
    },
  };
}

function readRequestIdentity(
  value: unknown,
): Pick<
  NativeWebSearchRequest,
  "request_id" | "operation_id" | "kind"
> | null {
  if (!isRecord(value)) return null;
  const { request_id, operation_id, kind } = value;
  if (
    typeof request_id !== "string" ||
    request_id.length === 0 ||
    typeof operation_id !== "string" ||
    operation_id.length === 0 ||
    (kind !== "web_search_execute" && kind !== "web_search_cancel")
  ) {
    return null;
  }
  return { request_id, operation_id, kind };
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
