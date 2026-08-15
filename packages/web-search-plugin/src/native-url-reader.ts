import {
  NATIVE_URL_READER_PROTOCOL_VERSION,
  parseNativeUrlReaderResponse,
  type NativeUrlReaderCancelRequest,
  type NativeUrlReaderRequest,
  type NativeUrlReaderResponse,
} from "./native-url-reader-protocol.ts";
import {
  createDirectOpenUrlResult,
  normalizePublicHttpUrl,
  type OpenUrlExecutor,
  type OpenUrlFormat,
  type OpenUrlResult,
} from "./url-reader.ts";

type PendingRequest = {
  request: NativeUrlReaderRequest;
  resolve(response: NativeUrlReaderResponse): void;
  reject(error: unknown): void;
};

export class NativeUrlReader implements OpenUrlExecutor {
  private readonly port: MessagePort;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeOperationIds = new Set<string>();
  private closed = false;

  constructor(port: MessagePort, options: { timeout_ms: number }) {
    this.port = port;
    this.timeoutMs = options.timeout_ms;
    port.addEventListener("message", this.handleMessage);
    port.addEventListener("messageerror", this.handleMessageError);
    port.start();
  }

  async open(
    url: string,
    format: OpenUrlFormat,
    signal?: AbortSignal,
  ): Promise<OpenUrlResult> {
    const normalizedUrl = normalizePublicHttpUrl(url);
    if (signal?.aborted) throw createAbortError();
    const operationId = crypto.randomUUID();
    const request = {
      protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
      request_id: crypto.randomUUID(),
      operation_id: operationId,
      kind: "url_reader_open",
      url: normalizedUrl,
      format,
      timeout_ms: this.timeoutMs,
    } as const;
    this.activeOperationIds.add(operationId);
    const abort = () => {
      void this.cancel(operationId);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.send(request);
      if (signal?.aborted) throw createAbortError();
      if (response.kind !== "url_reader_open_result") {
        throw new Error("Native URL reader returned the wrong response kind.");
      }
      if (!response.success) {
        if (response.code === "aborted") throw createAbortError();
        throw new Error(response.message);
      }
      return createDirectOpenUrlResult(response.result, format);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.activeOperationIds.delete(operationId);
    }
  }

  close(): void {
    if (this.closed) return;
    for (const operationId of this.activeOperationIds) {
      void this.cancel(operationId);
    }
    this.activeOperationIds.clear();
    this.closed = true;
    this.port.removeEventListener("message", this.handleMessage);
    this.port.removeEventListener("messageerror", this.handleMessageError);
    this.port.close();
    this.fail(new Error("The native URL reader channel was closed."));
  }

  private async cancel(operationId: string): Promise<void> {
    if (this.closed) return;
    const request: NativeUrlReaderCancelRequest = {
      protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
      request_id: crypto.randomUUID(),
      operation_id: operationId,
      kind: "url_reader_cancel",
    };
    try {
      await this.send(request);
    } catch {
      // Cancellation is best-effort while the owning core is shutting down.
    }
  }

  private send(request: NativeUrlReaderRequest): Promise<NativeUrlReaderResponse> {
    if (this.closed) {
      return Promise.reject(
        new Error("The native URL reader channel is closed."),
      );
    }
    if (this.pending.has(request.request_id)) {
      return Promise.reject(
        new Error(`Duplicate native URL reader request id: ${request.request_id}`),
      );
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.request_id, { request, resolve, reject });
      try {
        this.port.postMessage(request);
      } catch (error) {
        this.pending.delete(request.request_id);
        reject(error);
      }
    });
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    let response: NativeUrlReaderResponse;
    try {
      response = parseNativeUrlReaderResponse(event.data);
    } catch (error) {
      this.fail(error);
      return;
    }
    const pending = this.pending.get(response.request_id);
    if (!pending) return;
    if (pending.request.operation_id !== response.operation_id) {
      this.fail(
        new Error("Native URL reader returned a mismatched operation id."),
      );
      return;
    }
    this.pending.delete(response.request_id);
    pending.resolve(response);
  };

  private readonly handleMessageError = () => {
    this.fail(
      new Error("The native URL reader channel emitted an unreadable message."),
    );
  };

  private fail(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function createAbortError(): Error {
  return new DOMException("URL opening was aborted.", "AbortError");
}
