import {
  NativeProviderBodyEventSequenceValidator,
  parseNativeProviderBrokerMessage,
} from "./protocol.ts";
import {
  NATIVE_OPENAI_PROVIDER_ID,
  NATIVE_PROVIDER_PROTOCOL_VERSION,
  type NativeProviderBodyEvent,
  type NativeProviderCancelRequest,
  type NativeProviderEndpoint,
  type NativeProviderError,
  type NativeProviderFetchRequest,
  type NativeProviderRequest,
  type NativeProviderResponse,
  type NativeProviderResponseStartedEvent,
  type NativeProviderSessionAffinityHeaders,
} from "./wire-types.ts";

export const NATIVE_PROVIDER_MODELS_URL =
  "https://native-provider.researchbox.invalid/v1/models";
export const NATIVE_PROVIDER_CHAT_COMPLETIONS_URL =
  "https://native-provider.researchbox.invalid/v1/chat/completions";

export type NativeProviderRpcEndpoint = {
  postMessage(message: NativeProviderRequest): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  start?(): void;
  close?(): void;
};

export type NativeProviderRpcClientOptions = {
  create_request_id?: () => string;
  create_operation_id?: () => string;
};

type PendingRequest =
  | {
      kind: "fetch";
      operation_id: string;
    }
  | {
      kind: "cancel";
      operation_id: string;
    };

type ResponseMetadata = Pick<
  NativeProviderResponseStartedEvent,
  "status" | "status_text" | "headers"
>;

type PendingOperation = {
  operation_id: string;
  request_id: string;
  signal: AbortSignal;
  sequence: NativeProviderBodyEventSequenceValidator;
  body: ReadableStream<Uint8Array>;
  body_controller: ReadableStreamDefaultController<Uint8Array>;
  resolve(response: Response): void;
  reject(error: unknown): void;
  remove_abort_listener(): void;
  response_metadata: ResponseMetadata | null;
  start_acknowledged: boolean;
  response_settled: boolean;
  body_settled: boolean;
  terminal_received: boolean;
  abort_requested: boolean;
  cancel_sent: boolean;
};

export class NativeProviderRpcError extends Error {
  readonly code: NativeProviderError["code"];

  constructor(code: NativeProviderError["code"], message: string) {
    super(message);
    this.name = "NativeProviderRpcError";
    this.code = code;
  }
}

export class NativeProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeProviderProtocolError";
  }
}

export class NativeProviderRpcClient {
  private readonly endpoint: NativeProviderRpcEndpoint;
  private readonly createRequestId: () => string;
  private readonly createOperationId: () => string;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly operations = new Map<string, PendingOperation>();
  private closed = false;

  readonly fetch_request: typeof fetch = async (input, init) => {
    if (this.closed) {
      throw new NativeProviderProtocolError(
        "The native provider connection is closed.",
      );
    }

    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const endpoint = parseFetchEndpoint(request.url);
    validateRequestHeaders(request.headers, endpoint);
    const sessionAffinityHeaders = readSessionAffinityHeaders(
      request.headers,
      endpoint,
    );
    const body = await readRequestBody(request, endpoint);
    request.signal.throwIfAborted();
    return this.startFetch(
      endpoint,
      endpoint === "models" ? "get" : "post",
      body,
      request.signal,
      sessionAffinityHeaders,
    );
  };

  constructor(
    endpoint: NativeProviderRpcEndpoint,
    options: NativeProviderRpcClientOptions = {},
  ) {
    this.endpoint = endpoint;
    this.createRequestId =
      options.create_request_id ?? createDefaultRequestId;
    this.createOperationId =
      options.create_operation_id ?? createDefaultRequestId;
    this.endpoint.addEventListener("message", this.handleMessage);
    this.endpoint.addEventListener(
      "messageerror",
      this.handleMessageError,
    );
    this.endpoint.start?.();
  }

  close(): void {
    if (this.closed) return;
    const error = new NativeProviderProtocolError(
      "The native provider connection was closed.",
    );
    for (const operation of [...this.operations.values()]) {
      if (
        operation.start_acknowledged &&
        !operation.terminal_received
      ) {
        this.sendCancel(operation);
      }
    }
    this.failConnection(error);
  }

  private startFetch(
    endpoint: NativeProviderEndpoint,
    method: "get" | "post",
    body: string | undefined,
    signal: AbortSignal,
    sessionAffinityHeaders: NativeProviderSessionAffinityHeaders,
  ): Promise<Response> {
    if (this.closed) {
      return Promise.reject(
        new NativeProviderProtocolError(
          "The native provider connection is closed.",
        ),
      );
    }
    if (signal.aborted) {
      return Promise.reject(createAbortError(signal));
    }

    const operationId = this.createUniqueOperationId();
    const requestId = this.createUniqueRequestId();
    let bodyController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let operation: PendingOperation;
    const response = new Promise<Response>((resolve, reject) => {
      const readableBody = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        cancel: () => {
          operation.body_settled = true;
          this.requestAbort(
            operation,
            new DOMException(
              "The native provider response body was cancelled.",
              "AbortError",
            ),
            false,
          );
        },
      });
      if (!bodyController) {
        reject(
          new NativeProviderProtocolError(
            "Could not initialize the native provider response body.",
          ),
        );
        return;
      }

      const abort = () => {
        this.requestAbort(
          operation,
          createAbortError(signal),
          true,
        );
      };
      operation = {
        operation_id: operationId,
        request_id: requestId,
        signal,
        sequence: new NativeProviderBodyEventSequenceValidator(),
        body: readableBody,
        body_controller: bodyController,
        resolve,
        reject,
        remove_abort_listener: () =>
          signal.removeEventListener("abort", abort),
        response_metadata: null,
        start_acknowledged: false,
        response_settled: false,
        body_settled: false,
        terminal_received: false,
        abort_requested: false,
        cancel_sent: false,
      };
      signal.addEventListener("abort", abort, { once: true });
      this.operations.set(operationId, operation);
      this.pendingRequests.set(requestId, {
        kind: "fetch",
        operation_id: operationId,
      });

      const request: NativeProviderFetchRequest = {
        protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
        request_id: requestId,
        operation_id: operationId,
        provider_id: NATIVE_OPENAI_PROVIDER_ID,
        endpoint,
        method,
        ...(body === undefined ? {} : { body }),
        ...(Object.keys(sessionAffinityHeaders).length === 0
          ? {}
          : { session_affinity_headers: sessionAffinityHeaders }),
      };
      try {
        this.endpoint.postMessage(request);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        this.failOperation(operation, error, true);
      }
    });

    return response;
  }

  private readonly handleMessage = (
    event: MessageEvent<unknown>,
  ): void => {
    let message;
    try {
      message = parseNativeProviderBrokerMessage(event.data);
    } catch (error) {
      this.failProtocol(
        toProtocolError(
          error,
          "The native provider broker message was invalid.",
        ),
      );
      return;
    }

    if (
      "kind" in message &&
      message.kind === "connection_error"
    ) {
      this.failConnection(
        new NativeProviderProtocolError(message.error_message),
      );
      return;
    }
    if ("event_index" in message) {
      this.handleBodyEvent(message);
      return;
    }
    this.handleResponse(message);
  };

  private readonly handleMessageError = (): void => {
    this.failProtocol(
      new NativeProviderProtocolError(
        "The native provider broker message could not be decoded.",
      ),
    );
  };

  private handleResponse(
    response: NativeProviderResponse,
  ): void {
    const pending = this.pendingRequests.get(response.request_id);
    if (!pending) {
      this.failProtocol(
        new NativeProviderProtocolError(
          `Native provider returned an unknown request_id: ${response.request_id}.`,
        ),
      );
      return;
    }
    this.pendingRequests.delete(response.request_id);

    if (response.result.kind === "error") {
      const operation = this.operations.get(pending.operation_id);
      if (pending.kind === "fetch" && operation) {
        this.failOperation(
          operation,
          new NativeProviderRpcError(
            response.result.error.code,
            response.result.error.message,
          ),
          true,
        );
      } else if (pending.kind === "cancel" && operation) {
        this.failOperation(
          operation,
          new NativeProviderRpcError(
            response.result.error.code,
            response.result.error.message,
          ),
          true,
        );
      }
      return;
    }

    if (pending.kind === "fetch") {
      if (
        response.result.kind !== "fetch_started" ||
        response.result.operation_id !== pending.operation_id
      ) {
        this.failProtocol(
          new NativeProviderProtocolError(
            "Native provider returned a mismatched fetch acknowledgement.",
          ),
        );
        return;
      }
      const operation = this.operations.get(pending.operation_id);
      if (!operation) return;
      operation.start_acknowledged = true;
      if (operation.abort_requested && !operation.terminal_received) {
        this.sendCancel(operation);
      }
      this.maybeSettleResponse(operation);
      this.maybeReleaseOperation(operation);
      return;
    }

    if (
      response.result.kind !== "operation_cancelled" ||
      response.result.operation_id !== pending.operation_id
    ) {
      this.failProtocol(
        new NativeProviderProtocolError(
          "Native provider returned a mismatched cancellation acknowledgement.",
        ),
      );
    }
  }

  private handleBodyEvent(event: NativeProviderBodyEvent): void {
    const operation = this.operations.get(event.operation_id);
    if (!operation) {
      this.failProtocol(
        new NativeProviderProtocolError(
          `Native provider emitted an event for unknown operation_id: ${event.operation_id}.`,
        ),
      );
      return;
    }

    let accepted: NativeProviderBodyEvent;
    try {
      accepted = operation.sequence.accept(event);
    } catch (error) {
      this.failProtocol(
        toProtocolError(
          error,
          "The native provider body event sequence was invalid.",
        ),
      );
      return;
    }

    switch (accepted.kind) {
      case "response_started":
        operation.response_metadata = {
          status: accepted.status,
          status_text: accepted.status_text,
          headers: accepted.headers,
        };
        this.maybeSettleResponse(operation);
        break;
      case "body_chunk":
        if (!operation.abort_requested && !operation.body_settled) {
          try {
            operation.body_controller.enqueue(
              decodeBase64(accepted.chunk_base64),
            );
          } catch (error) {
            this.failProtocol(
              toProtocolError(
                error,
                "The native provider body chunk could not be decoded.",
              ),
            );
            return;
          }
        }
        break;
      case "body_finished":
        operation.terminal_received = true;
        if (accepted.status === "complete") {
          this.closeBody(operation);
        } else {
          const error =
            accepted.status === "aborted"
              ? createAbortError(operation.signal)
              : new Error(
                  accepted.error_message ??
                    "The native provider request failed.",
                );
          this.failOperation(operation, error, false);
        }
        break;
    }

    this.maybeSettleResponse(operation);
    this.maybeReleaseOperation(operation);
  }

  private maybeSettleResponse(operation: PendingOperation): void {
    if (
      operation.response_settled ||
      operation.abort_requested ||
      !operation.start_acknowledged ||
      !operation.response_metadata
    ) {
      return;
    }
    const metadata = operation.response_metadata;
    try {
      const hasBody =
        metadata.status !== 204 &&
        metadata.status !== 205 &&
        metadata.status !== 304;
      operation.response_settled = true;
      operation.resolve(
        new Response(hasBody ? operation.body : null, {
          status: metadata.status,
          statusText: metadata.status_text,
          headers: metadata.headers,
        }),
      );
    } catch (error) {
      this.failProtocol(
        toProtocolError(
          error,
          "Could not construct the native provider response.",
        ),
      );
    }
  }

  private requestAbort(
    operation: PendingOperation,
    error: Error,
    errorBody: boolean,
  ): void {
    if (operation.abort_requested) return;
    operation.abort_requested = true;
    if (!operation.response_settled) {
      operation.response_settled = true;
      operation.reject(error);
    }
    if (errorBody) this.errorBody(operation, error);
    if (operation.terminal_received) {
      this.maybeReleaseOperation(operation);
      return;
    }
    if (operation.start_acknowledged) this.sendCancel(operation);
  }

  private sendCancel(operation: PendingOperation): void {
    if (
      operation.cancel_sent ||
      operation.terminal_received ||
      this.closed
    ) {
      return;
    }
    operation.cancel_sent = true;
    let requestId: string;
    try {
      requestId = this.createUniqueRequestId();
    } catch (error) {
      this.failProtocol(
        toProtocolError(
          error,
          "Could not allocate native provider cancellation.",
        ),
      );
      return;
    }
    const request: NativeProviderCancelRequest = {
      protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
      request_id: requestId,
      operation_id: operation.operation_id,
    };
    this.pendingRequests.set(requestId, {
      kind: "cancel",
      operation_id: operation.operation_id,
    });
    try {
      this.endpoint.postMessage(request);
    } catch (error) {
      this.pendingRequests.delete(requestId);
      this.failProtocol(
        toProtocolError(
          error,
          "Could not send native provider cancellation.",
        ),
      );
    }
  }

  private failOperation(
    operation: PendingOperation,
    error: unknown,
    terminal: boolean,
  ): void {
    const failure =
      error instanceof Error
        ? error
        : new Error("The native provider operation failed.");
    if (!operation.response_settled) {
      operation.response_settled = true;
      operation.reject(failure);
    }
    this.errorBody(operation, failure);
    if (terminal) operation.terminal_received = true;
    this.maybeReleaseOperation(operation);
  }

  private closeBody(operation: PendingOperation): void {
    if (operation.body_settled) return;
    operation.body_settled = true;
    try {
      operation.body_controller.close();
    } catch {
      // The consumer may have cancelled the stream first.
    }
  }

  private errorBody(
    operation: PendingOperation,
    error: Error,
  ): void {
    if (operation.body_settled) return;
    operation.body_settled = true;
    try {
      operation.body_controller.error(error);
    } catch {
      // The consumer may have cancelled the stream first.
    }
  }

  private maybeReleaseOperation(operation: PendingOperation): void {
    if (
      !operation.terminal_received ||
      this.pendingRequests.has(operation.request_id)
    ) {
      return;
    }
    if (this.operations.get(operation.operation_id) !== operation) return;
    operation.remove_abort_listener();
    this.operations.delete(operation.operation_id);
  }

  private createUniqueRequestId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const requestId = this.createRequestId();
      if (
        requestId.length > 0 &&
        !this.pendingRequests.has(requestId)
      ) {
        return requestId;
      }
    }
    throw new NativeProviderProtocolError(
      "Could not allocate a unique native provider request id.",
    );
  }

  private createUniqueOperationId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const operationId = this.createOperationId();
      if (operationId.length > 0 && !this.operations.has(operationId)) {
        return operationId;
      }
    }
    throw new NativeProviderProtocolError(
      "Could not allocate a unique native provider operation id.",
    );
  }

  private failProtocol(error: NativeProviderProtocolError): void {
    this.failConnection(error);
  }

  private failConnection(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.endpoint.removeEventListener("message", this.handleMessage);
    this.endpoint.removeEventListener(
      "messageerror",
      this.handleMessageError,
    );
    this.endpoint.close?.();
    this.pendingRequests.clear();
    for (const operation of this.operations.values()) {
      operation.remove_abort_listener();
      if (!operation.response_settled) {
        operation.response_settled = true;
        operation.reject(error);
      }
      this.errorBody(operation, error);
    }
    this.operations.clear();
  }
}

function parseFetchEndpoint(url: string): NativeProviderEndpoint {
  switch (url) {
    case NATIVE_PROVIDER_MODELS_URL:
      return "models";
    case NATIVE_PROVIDER_CHAT_COMPLETIONS_URL:
      return "chat_completions";
    default:
      throw new NativeProviderProtocolError(
        `Unsupported native provider URL: ${url}`,
      );
  }
}

function validateRequestHeaders(
  headers: Headers,
  endpoint: NativeProviderEndpoint,
): void {
  const allowed = new Set(
    endpoint === "models"
      ? ["accept"]
      : [
          "accept",
          "content-type",
          "session_id",
          "x-client-request-id",
          "x-session-affinity",
        ],
  );
  for (const [name] of headers) {
    if (!allowed.has(name)) {
      throw new NativeProviderProtocolError(
        `Native provider request header is not supported: ${name}.`,
      );
    }
  }
  const accept = headers.get("accept");
  const expectedAccept =
    endpoint === "models" ? "application/json" : "text/event-stream";
  if (accept !== expectedAccept) {
    throw new NativeProviderProtocolError(
      `Native provider ${endpoint} request requires Accept: ${expectedAccept}.`,
    );
  }
  if (
    endpoint === "chat_completions" &&
    headers.get("content-type") !== "application/json"
  ) {
    throw new NativeProviderProtocolError(
      "Native provider chat_completions requires Content-Type: application/json.",
    );
  }
}

function readSessionAffinityHeaders(
  headers: Headers,
  endpoint: NativeProviderEndpoint,
): NativeProviderSessionAffinityHeaders {
  if (endpoint === "models") return {};

  const names = [
    "session_id",
    "x-client-request-id",
    "x-session-affinity",
  ] as const;
  const sessionAffinityHeaders: NativeProviderSessionAffinityHeaders = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) sessionAffinityHeaders[name] = value;
  }

  const values = new Set(Object.values(sessionAffinityHeaders));
  if (values.size > 1) {
    throw new NativeProviderProtocolError(
      "Native provider session-affinity headers must use the same value.",
    );
  }
  return sessionAffinityHeaders;
}

async function readRequestBody(
  request: Request,
  endpoint: NativeProviderEndpoint,
): Promise<string | undefined> {
  if (endpoint === "models") {
    if (request.method !== "GET" || request.body !== null) {
      throw new NativeProviderProtocolError(
        "Native provider models requests must use GET without a body.",
      );
    }
    return undefined;
  }
  if (request.method !== "POST" || request.body === null) {
    throw new NativeProviderProtocolError(
      "Native provider chat_completions requests must use POST with a body.",
    );
  }
  const body = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new NativeProviderProtocolError(
      "Native provider chat_completions body must be valid JSON.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NativeProviderProtocolError(
      "Native provider chat_completions body must be a JSON object.",
    );
  }
  return body;
}

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function createDefaultRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function createAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function toProtocolError(
  error: unknown,
  fallback: string,
): NativeProviderProtocolError {
  return new NativeProviderProtocolError(
    error instanceof Error ? error.message : fallback,
  );
}
