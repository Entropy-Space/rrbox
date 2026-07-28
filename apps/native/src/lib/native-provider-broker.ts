import {
  NATIVE_PROVIDER_PROTOCOL_VERSION,
  NativeProviderBodyEventSequenceValidator,
  createNativeProviderConnectionError,
  createNativeProviderErrorResponse,
  parseNativeProviderBodyEvent,
  parseNativeProviderCancelResponse,
  parseNativeProviderFetchResponse,
  parseNativeProviderRequest,
  type NativeProviderBodyFinishedEvent,
  type NativeProviderCancelRequest,
  type NativeProviderFetchRequest,
  type NativeProviderRequest,
} from "@researchbox/provider-native";
import { nativeProviderCommands } from "./tauri.ts";
import type { NativeProviderCommands } from "./types.ts";

export type NativeProviderPortBroker = {
  close(): void;
};

type ActiveFetch = {
  request: NativeProviderFetchRequest;
  validator: NativeProviderBodyEventSequenceValidator;
  forward_events: boolean;
  start_settled: boolean;
  start_succeeded: boolean;
  terminal_received: boolean;
  cancel_requested: boolean;
  cancel_sent: boolean;
};

export function createNativeProviderPortBroker(
  port: MessagePort,
  commands: NativeProviderCommands = nativeProviderCommands,
): NativeProviderPortBroker {
  const activeFetches = new Map<string, ActiveFetch>();
  const pendingRequestIds = new Set<string>();
  let closed = false;

  function postMessage(message: unknown): boolean {
    if (closed) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      closeWithError(
        "The native provider broker could not send a message.",
        false,
      );
      return false;
    }
  }

  function closeWithError(
    message: string,
    notifyWorker = true,
  ): void {
    if (closed) return;
    if (notifyWorker) {
      try {
        port.postMessage(createNativeProviderConnectionError(message));
      } catch {
        // The port is already unusable.
      }
    }
    closed = true;
    for (const active of activeFetches.values()) {
      active.forward_events = false;
      requestNativeCancel(active);
    }
    pendingRequestIds.clear();
    port.removeEventListener("message", handleMessage);
    port.removeEventListener("messageerror", handleMessageError);
    port.close();
  }

  function rejectRequest(
    requestId: string,
    message: string,
  ): void {
    postMessage(
      createNativeProviderErrorResponse(requestId, {
        code: "invalid_request",
        message,
      }),
    );
  }

  function requestNativeCancel(active: ActiveFetch): void {
    active.cancel_requested = true;
    if (
      active.cancel_sent ||
      !active.start_settled ||
      !active.start_succeeded ||
      active.terminal_received
    ) {
      return;
    }

    active.cancel_sent = true;
    let request: NativeProviderCancelRequest;
    try {
      request = {
        protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
        request_id: createInternalRequestId(pendingRequestIds),
        operation_id: active.request.operation_id,
      };
    } catch {
      activeFetches.delete(active.request.operation_id);
      return;
    }
    void Promise.resolve()
      .then(() => commands.cancel(request))
      .then(
        (rawResponse) => {
          try {
            const response =
              parseNativeProviderCancelResponse(rawResponse);
            if (
              response.request_id !== request.request_id ||
              (response.result.kind === "operation_cancelled" &&
                response.result.operation_id !== request.operation_id)
            ) {
              throw new Error(
                "Native provider returned a mismatched internal cancellation acknowledgement.",
              );
            }
          } catch {
            // This is best-effort cleanup after the worker stopped consuming.
          } finally {
            activeFetches.delete(active.request.operation_id);
          }
        },
        () => {
          activeFetches.delete(active.request.operation_id);
        },
      );
  }

  function failActiveFetch(
    active: ActiveFetch,
    error: unknown,
  ): void {
    if (!active.forward_events) return;
    active.forward_events = false;
    const terminal = createIsolatedFailureEvent(
      active.request.operation_id,
      active.validator.next_event_index,
      toErrorMessage(
        error,
        "The native provider channel emitted an invalid event.",
      ),
    );
    postMessage(terminal);
    requestNativeCancel(active);
  }

  function handleFetch(request: NativeProviderFetchRequest): void {
    if (activeFetches.has(request.operation_id)) {
      rejectRequest(
        request.request_id,
        `Native provider operation_id is already active: ${request.operation_id}.`,
      );
      pendingRequestIds.delete(request.request_id);
      return;
    }
    const active: ActiveFetch = {
      request,
      validator: new NativeProviderBodyEventSequenceValidator(),
      forward_events: true,
      start_settled: false,
      start_succeeded: false,
      terminal_received: false,
      cancel_requested: false,
      cancel_sent: false,
    };
    activeFetches.set(request.operation_id, active);

    const onEvent = (rawEvent: unknown): void => {
      if (!active.forward_events) return;
      try {
        const event = parseNativeProviderBodyEvent(rawEvent);
        if (event.operation_id !== request.operation_id) {
          throw new Error(
            "Native provider channel emitted an event for a different operation.",
          );
        }
        const accepted = active.validator.accept(event);
        if (!postMessage(accepted)) return;
        if (accepted.kind === "body_finished") {
          active.terminal_received = true;
          active.forward_events = false;
          activeFetches.delete(request.operation_id);
        }
      } catch (error) {
        failActiveFetch(active, error);
      }
    };

    void Promise.resolve()
      .then(() => commands.fetch(request, onEvent))
      .then(
        (rawResponse) => {
          pendingRequestIds.delete(request.request_id);
          active.start_settled = true;
          try {
            const response =
              parseNativeProviderFetchResponse(rawResponse);
            if (response.request_id !== request.request_id) {
              throw new Error(
                "Native provider fetch returned a different request_id.",
              );
            }
            if (
              response.result.kind === "fetch_started" &&
              response.result.operation_id !== request.operation_id
            ) {
              throw new Error(
                "Native provider fetch returned a different operation_id.",
              );
            }

            active.start_succeeded =
              response.result.kind === "fetch_started";
            if (response.result.kind === "error") {
              active.forward_events = false;
              activeFetches.delete(request.operation_id);
            }
            if (!closed) postMessage(response);
            if (
              active.cancel_requested ||
              closed ||
              !active.forward_events
            ) {
              requestNativeCancel(active);
            }
          } catch (error) {
            // The invoke settled, so conservatively assume Rust registered
            // the operation and issue an idempotent cancellation.
            active.start_succeeded = true;
            if (!closed) {
              postMessage(
                createNativeProviderErrorResponse(request.request_id, {
                  code: "internal",
                  message: toErrorMessage(
                    error,
                    "Native provider fetch returned an invalid response.",
                  ),
                }),
              );
            }
            failActiveFetch(active, error);
            requestNativeCancel(active);
          }
        },
        (error: unknown) => {
          pendingRequestIds.delete(request.request_id);
          active.start_settled = true;
          // An invoke can reject after Rust accepted the Channel.
          // Cancellation is idempotent, so treating this as possibly started
          // avoids leaking the upstream request.
          active.start_succeeded = true;
          if (!closed) {
            postMessage(
              createNativeProviderErrorResponse(request.request_id, {
                code: "internal",
                message: toErrorMessage(
                  error,
                  "The native provider fetch command failed.",
                ),
              }),
            );
          }
          active.forward_events = false;
          requestNativeCancel(active);
        },
      );
  }

  function handleCancel(request: NativeProviderCancelRequest): void {
    const isolateCancelFailure = (error: unknown): void => {
      const active = activeFetches.get(request.operation_id);
      if (active) failActiveFetch(active, error);
    };

    void Promise.resolve()
      .then(() => commands.cancel(request))
      .then(
        (rawResponse) => {
          pendingRequestIds.delete(request.request_id);
          if (closed) return;
          try {
            const response =
              parseNativeProviderCancelResponse(rawResponse);
            if (response.request_id !== request.request_id) {
              throw new Error(
                "Native provider cancel returned a different request_id.",
              );
            }
            if (
              response.result.kind === "operation_cancelled" &&
              response.result.operation_id !== request.operation_id
            ) {
              throw new Error(
                "Native provider cancel returned a different operation_id.",
              );
            }
            if (response.result.kind === "error") {
              isolateCancelFailure(
                new Error(response.result.error.message),
              );
            }
            postMessage(response);
          } catch (error) {
            isolateCancelFailure(error);
            postMessage(
              createNativeProviderErrorResponse(request.request_id, {
                code: "internal",
                message: toErrorMessage(
                  error,
                  "Native provider cancel returned an invalid response.",
                ),
              }),
            );
          }
        },
        (error: unknown) => {
          pendingRequestIds.delete(request.request_id);
          if (closed) return;
          isolateCancelFailure(error);
          postMessage(
            createNativeProviderErrorResponse(request.request_id, {
              code: "internal",
              message: toErrorMessage(
                error,
                "The native provider cancel command failed.",
              ),
            }),
          );
        },
      );
  }

  function handleMessage(event: MessageEvent<unknown>): void {
    let request: NativeProviderRequest;
    try {
      request = parseNativeProviderRequest(event.data);
    } catch (error) {
      const requestId = readIdentifier(event.data, "request_id");
      if (requestId === null) {
        closeWithError(
          toErrorMessage(
            error,
            "The native provider request was invalid.",
          ),
        );
      } else if (pendingRequestIds.has(requestId)) {
        closeWithError(
          `Native provider request_id is already pending: ${requestId}.`,
        );
      } else {
        rejectRequest(
          requestId,
          toErrorMessage(
            error,
            "The native provider request was invalid.",
          ),
        );
      }
      return;
    }

    if (pendingRequestIds.has(request.request_id)) {
      closeWithError(
        `Native provider request_id is already pending: ${request.request_id}.`,
      );
      return;
    }
    pendingRequestIds.add(request.request_id);
    if ("provider_id" in request) {
      handleFetch(request);
    } else {
      handleCancel(request);
    }
  }

  function handleMessageError(): void {
    closeWithError(
      "The native provider request could not be decoded.",
    );
  }

  port.addEventListener("message", handleMessage);
  port.addEventListener("messageerror", handleMessageError);
  port.start();

  return {
    close() {
      closeWithError("The native provider broker was closed.");
    },
  };
}

function createIsolatedFailureEvent(
  operationId: string,
  eventIndex: number,
  errorMessage: string,
): NativeProviderBodyFinishedEvent {
  return {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    operation_id: operationId,
    event_index: eventIndex,
    kind: "body_finished",
    status: "error",
    error_message: errorMessage,
  };
}

function createInternalRequestId(
  pendingRequestIds: ReadonlySet<string>,
): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const requestId = `broker-cancel-${crypto.randomUUID()}`;
    if (!pendingRequestIds.has(requestId)) return requestId;
  }
  throw new Error(
    "Could not allocate a native provider cancellation request_id.",
  );
}

function readIdentifier(
  value: unknown,
  field: string,
): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !(field in value)
  ) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.trim() === candidate
  )
    ? candidate
    : null;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
