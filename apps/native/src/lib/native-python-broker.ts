import {
  createPythonErrorResponse,
  parsePythonRequest,
  type PythonExecuteRequest,
  type PythonRequest,
} from "@researchbox/python-plugin/protocol";
import { nativePythonCommands } from "./tauri.ts";
import type { NativePythonCommands } from "./types.ts";

export type NativePythonPortBroker = {
  close(): void;
};

export function createNativePythonPortBroker(
  port: MessagePort,
  commands: NativePythonCommands = nativePythonCommands,
): NativePythonPortBroker {
  const pendingRequestIds = new Set<string>();
  const activeExecutions = new Map<string, PythonExecuteRequest>();
  let closed = false;

  const postMessage = (message: unknown) => {
    if (!closed) port.postMessage(message);
  };

  const handleMessage = (event: MessageEvent<unknown>) => {
    let request: PythonRequest;
    try {
      request = parsePythonRequest(event.data);
    } catch (error) {
      const requestId = readRequestId(event.data);
      const kind = readRequestKind(event.data);
      if (requestId !== null && kind !== null) {
        postMessage(
          createPythonErrorResponse(
            { request_id: requestId, kind },
            "invalid_request",
            toErrorMessage(error, "The Python request was invalid."),
          ),
        );
      }
      return;
    }

    if (pendingRequestIds.has(request.request_id)) {
      postMessage(
        createPythonErrorResponse(
          request,
          "invalid_request",
          `Duplicate Python request id: ${request.request_id}`,
        ),
      );
      return;
    }
    pendingRequestIds.add(request.request_id);

    if (request.kind === "python_execute") {
      if (activeExecutions.has(request.operation_id)) {
        pendingRequestIds.delete(request.request_id);
        postMessage(
          createPythonErrorResponse(
            request,
            "busy",
            `Python operation is already active: ${request.operation_id}`,
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
            createPythonErrorResponse(
              request,
              "internal",
              toErrorMessage(
                error,
                "The native Python execution failed.",
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
          createPythonErrorResponse(
            request,
            "internal",
            toErrorMessage(
              error,
              "The native Python cancellation failed.",
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
          kind: "python_cancel",
        });
      }
      activeExecutions.clear();
      pendingRequestIds.clear();
      port.close();
    },
  };
}

function readRequestId(value: unknown): string | null {
  return isRecord(value) &&
    typeof value.request_id === "string" &&
    value.request_id.length > 0
    ? value.request_id
    : null;
}

function readRequestKind(
  value: unknown,
): PythonRequest["kind"] | null {
  if (!isRecord(value)) return null;
  return value.kind === "python_execute" ||
    value.kind === "python_cancel"
    ? value.kind
    : null;
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
