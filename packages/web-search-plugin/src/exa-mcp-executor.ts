import {
  MAX_WEB_SEARCH_QUERY_BYTES,
  type WebSearchExecutor,
  type WebSearchRequest,
} from "./web-search-plugin.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type ExaMcpResponse = {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: {
    code?: number;
    message?: string;
  };
};

export class ExaMcpWebSearchExecutor implements WebSearchExecutor {
  private readonly timeoutMs: number;
  private readonly maximumResults: number;
  private readonly maxOutputBytes: number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly activeRequests = new Set<AbortController>();
  private closed = false;

  constructor(options: {
    timeout_ms: number;
    maximum_results: number;
    max_output_bytes: number;
    fetch?: typeof globalThis.fetch;
  }) {
    this.timeoutMs = options.timeout_ms;
    this.maximumResults = options.maximum_results;
    this.maxOutputBytes = options.max_output_bytes;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.closed) throw new Error("The web search executor is closed.");
    validateRequest(request, this.maximumResults);
    if (signal?.aborted) throw createAbortError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, this.timeoutMs);
    this.activeRequests.add(controller);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetch(EXA_MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query: enrichQuery(request),
              numResults: request.num_results,
              livecrawl: "fallback",
              type: "auto",
              contextMaxCharacters: this.maxOutputBytes,
            },
          },
        }),
        signal: controller.signal,
      });
      const body = await readBoundedText(response, MAX_RESPONSE_BYTES);
      if (!response.ok) {
        throw new Error(
          `Web search failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
        );
      }
      const parsed = parseMcpResponse(body);
      if (parsed.error) {
        throw new Error(
          parsed.error.message || "The web search provider returned an error.",
        );
      }
      const text = parsed.result?.content?.find(
        (item) =>
          item.type === "text" &&
          typeof item.text === "string" &&
          item.text.trim().length > 0,
      )?.text;
      if (parsed.result?.isError || !text) {
        throw new Error(
          text || "The web search provider returned no results.",
        );
      }
      return truncateUtf8(text, this.maxOutputBytes);
    } catch (error) {
      if (controller.signal.aborted) throw createAbortError();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.activeRequests.delete(controller);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.activeRequests) {
      controller.abort();
    }
    this.activeRequests.clear();
  }
}

function enrichQuery(request: WebSearchRequest): string {
  if (!request.recency_filter) return request.query;
  const suffix = {
    day: "past 24 hours",
    week: "past week",
    month: "past month",
    year: "past year",
  }[request.recency_filter];
  return `${request.query} ${suffix}`;
}

function validateRequest(
  request: WebSearchRequest,
  maximumResults: number,
): void {
  const queryBytes = new TextEncoder().encode(request.query).byteLength;
  if (request.query.trim().length === 0 || queryBytes > MAX_WEB_SEARCH_QUERY_BYTES) {
    throw new Error("Web search query is empty or too large.");
  }
  if (
    !Number.isSafeInteger(request.num_results) ||
    request.num_results < 1 ||
    request.num_results > maximumResults
  ) {
    throw new Error(`Web search num_results must be between 1 and ${maximumResults}.`);
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("The web search provider response was too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function parseMcpResponse(body: string): ExaMcpResponse {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const candidate = parseJsonResponse(line.slice(5).trim());
    if (candidate) return candidate;
  }
  const candidate = parseJsonResponse(body);
  if (!candidate) {
    throw new Error("The web search provider returned an invalid response.");
  }
  return candidate;
}

function parseJsonResponse(value: string): ExaMcpResponse | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const response = parsed as ExaMcpResponse;
    return response.result || response.error ? response : null;
  } catch {
    return null;
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const suffix = "\n\n[search output truncated]";
  const suffixBytes = new TextEncoder().encode(suffix).byteLength;
  const budget = Math.max(0, maximumBytes - suffixBytes);
  let end = budget;
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return new TextDecoder().decode(encoded.slice(0, end)) + suffix;
}

function createAbortError(): Error {
  return new DOMException("Web search was cancelled.", "AbortError");
}
