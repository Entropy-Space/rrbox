import {
  NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
  parseNativeWebSearchResponse,
  type NativeWebSearchCancelRequest,
  type NativeWebSearchRequest,
  type NativeWebSearchResponse,
} from "./native-protocol.ts";
import {
  classifyProviderError,
  type WebSearchProvider,
  WebSearchProviderError,
} from "./routing-executor.ts";
import type {
  WebSearchRequest,
  WebSearchResponse,
} from "./web-search-plugin.ts";

type PendingRequest = {
  request: NativeWebSearchRequest;
  resolve(response: NativeWebSearchResponse): void;
  reject(error: unknown): void;
};

export class NativeAnySearchWebSearchProvider
  implements WebSearchProvider {
  readonly id = "anysearch" as const;
  private readonly port: MessagePort;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activeOperationIds = new Set<string>();
  private closed = false;

  constructor(
    port: MessagePort,
    options: { timeout_ms: number },
  ) {
    this.port = port;
    this.timeoutMs = options.timeout_ms;
    port.addEventListener("message", this.handleMessage);
    port.addEventListener("messageerror", this.handleMessageError);
    port.start();
  }

  async search(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    if (signal?.aborted) throw createAbortError();
    const operationId = crypto.randomUUID();
    const nativeRequest = {
      protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
      request_id: crypto.randomUUID(),
      operation_id: operationId,
      kind: "web_search_execute",
      provider_id: "anysearch",
      query: enrichQuery(request),
      num_results: request.num_results,
      include_content: request.include_content,
      timeout_ms: this.timeoutMs,
    } as const;
    this.activeOperationIds.add(operationId);
    const abort = () => {
      void this.cancel(operationId);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.send(nativeRequest);
      if (signal?.aborted) throw createAbortError();
      if (response.kind !== "web_search_execute_result") {
        throw new Error(
          "Native web search returned the wrong response kind.",
        );
      }
      if (!response.success) {
        if (response.code === "aborted") throw createAbortError();
        const kind = response.code === "network"
          ? "network"
          : response.code === "timeout"
          ? "transient"
          : classifyProviderError(this.id, response.message).kind;
        throw new WebSearchProviderError({
          provider_id: this.id,
          kind,
          message: response.message,
        });
      }
      return {
        ...response.response,
        query: request.query,
      };
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
    this.port.removeEventListener(
      "messageerror",
      this.handleMessageError,
    );
    this.port.close();
    this.fail(new Error("The native web search channel was closed."));
  }

  private async cancel(operationId: string): Promise<void> {
    if (this.closed) return;
    const request: NativeWebSearchCancelRequest = {
      protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
      request_id: crypto.randomUUID(),
      operation_id: operationId,
      kind: "web_search_cancel",
    };
    try {
      await this.send(request);
    } catch {
      // Cancellation is best-effort while the owning core is shutting down.
    }
  }

  private send(
    request: NativeWebSearchRequest,
  ): Promise<NativeWebSearchResponse> {
    if (this.closed) {
      return Promise.reject(
        new Error("The native web search channel is closed."),
      );
    }
    if (this.pending.has(request.request_id)) {
      return Promise.reject(
        new Error(
          `Duplicate native web search request id: ${request.request_id}`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.request_id, {
        request,
        resolve,
        reject,
      });
      try {
        this.port.postMessage(request);
      } catch (error) {
        this.pending.delete(request.request_id);
        reject(error);
      }
    });
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    let response: NativeWebSearchResponse;
    try {
      response = parseNativeWebSearchResponse(event.data);
    } catch (error) {
      this.fail(error);
      return;
    }
    const pending = this.pending.get(response.request_id);
    if (!pending) return;
    if (pending.request.operation_id !== response.operation_id) {
      this.fail(
        new Error(
          "Native web search returned a mismatched operation id.",
        ),
      );
      return;
    }
    this.pending.delete(response.request_id);
    pending.resolve(response);
  };

  private readonly handleMessageError = () => {
    this.fail(
      new Error(
        "The native web search channel emitted an unreadable message.",
      ),
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
  return new DOMException("Web search was aborted.", "AbortError");
}

function enrichQuery(request: WebSearchRequest): string {
  const parts = [request.query];
  for (const domain of request.domain_filter ?? []) {
    parts.push(
      domain.startsWith("-")
        ? `-site:${domain.slice(1)}`
        : `site:${domain}`,
    );
  }
  if (request.recency_filter) {
    const suffix = {
      day: "past 24 hours",
      week: "past week",
      month: "past month",
      year: "past year",
    }[request.recency_filter];
    parts.push(suffix);
  }
  return parts.join(" ");
}
