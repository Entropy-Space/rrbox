import {
  MAX_WEB_SEARCH_QUERY_BYTES,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchSource,
} from "./web-search-plugin.ts";
import type { WebSearchProvider } from "./routing-executor.ts";

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

export class ExaMcpWebSearchProvider implements WebSearchProvider {
  readonly id = "exa" as const;
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
  ): Promise<WebSearchResponse> {
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
      const sources = parseMcpResults(
        text,
        request.num_results,
        this.maxOutputBytes,
      );
      if (sources.length === 0) {
        throw new Error(
          "The web search provider returned no parseable sources.",
        );
      }
      return {
        query: request.query,
        provider: "exa",
        answer: buildAnswer(sources),
        sources: sources.map(({ content, ...source }) => ({
          ...source,
          ...(request.include_content ? { content } : {}),
        })),
      };
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

/** @deprecated Compose ExaMcpWebSearchProvider with RoutingWebSearchExecutor. */
export const ExaMcpWebSearchExecutor = ExaMcpWebSearchProvider;

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
  if (request.provider !== "auto" && request.provider !== "exa") {
    throw new Error(`Unsupported web search provider: ${request.provider}`);
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

function parseMcpResults(
  value: string,
  maximumResults: number,
  maximumContentBytes: number,
): Array<
  WebSearchSource & { content: string }
> {
  const blocks = value
    .split(/(?=^Title: )/mu)
    .filter((block) => block.trim().length > 0);
  const results: Array<WebSearchSource & { content: string }> = [];
  let remainingContentBytes = maximumContentBytes;
  for (const block of blocks) {
    if (results.length >= maximumResults) break;
    const title = truncate(
      block.match(/^Title: (.+)$/mu)?.[1]?.trim() ?? "",
      500,
    );
    const url = truncate(
      block.match(/^URL: (.+)$/mu)?.[1]?.trim() ?? "",
      2_048,
    );
    if (!url || !isPublicHttpUrl(url)) continue;
    const textStart = block.indexOf("\nText: ");
    const highlightsStart = block.search(/\nHighlights:\s*\n/mu);
    let content = "";
    if (textStart >= 0) {
      content = block.slice(textStart + 7);
    } else if (highlightsStart >= 0) {
      const marker = block.match(/\nHighlights:\s*\n/mu)?.[0] ?? "";
      content = block.slice(highlightsStart + marker.length);
    }
    const contentBudget = Math.min(
      16 * 1024,
      remainingContentBytes,
    );
    content = truncateUtf8(
      content.replace(/\n---\s*$/u, "").trim(),
      contentBudget,
    );
    remainingContentBytes -= new TextEncoder().encode(content).byteLength;
    results.push({
      title: title || `Source ${results.length + 1}`,
      url,
      snippet: truncate(
        content.replace(/\s+/gu, " ").trim(),
        600,
      ),
      content,
    });
  }
  return results;
}

function buildAnswer(
  sources: Array<WebSearchSource & { content: string }>,
): string {
  return sources.map((source) => {
    const evidence = source.snippet ||
      "The provider returned this source without an excerpt.";
    return `${evidence}\nSource: ${source.title} (${source.url})`;
  }).join("\n\n");
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum - 1)}…`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const suffix = "\n\n[search output truncated]";
  const suffixBytes = new TextEncoder().encode(suffix).byteLength;
  if (suffixBytes >= maximumBytes) {
    return decodeUtf8Prefix(encoded, maximumBytes);
  }
  const budget = Math.max(0, maximumBytes - suffixBytes);
  return decodeUtf8Prefix(encoded, budget) + suffix;
}

function decodeUtf8Prefix(value: Uint8Array, maximumBytes: number): string {
  let end = Math.min(maximumBytes, value.byteLength);
  while (
    end > 0 &&
    end < value.byteLength &&
    (value[end] & 0b1100_0000) === 0b1000_0000
  ) {
    end -= 1;
  }
  return new TextDecoder().decode(value.slice(0, end));
}

function createAbortError(): Error {
  return new DOMException("Web search was cancelled.", "AbortError");
}
