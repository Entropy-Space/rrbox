export const MAX_OPEN_URL_BYTES = 2 * 1024 * 1024;
const JINA_READER_BASE_URL = "https://r.jina.ai/";

export type OpenUrlFormat = "html" | "markdown";

export type OpenUrlExecutor = {
  open(
    url: string,
    format: OpenUrlFormat,
    signal?: AbortSignal,
  ): Promise<OpenUrlResult>;
  close?(): void | Promise<void>;
};

export type OpenUrlResult = {
  requested_url: string;
  final_url: string;
  status: number;
  content_type: string;
  title: string;
  content: string;
  source: "direct" | "reader";
};

export async function openUrl(
  url: string,
  format: OpenUrlFormat,
  signal?: AbortSignal,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<OpenUrlResult> {
  const normalizedUrl = normalizePublicHttpUrl(url);
  if (signal?.aborted) throw createAbortError();

  try {
    return await fetchDirectUrl(
      normalizedUrl,
      format,
      signal,
      fetchImpl,
    );
  } catch (error) {
    if (format === "html" || signal?.aborted || isAbortError(error)) {
      throw error;
    }
    return fetchReaderMarkdown(normalizedUrl, signal, fetchImpl);
  }
}

export function normalizePublicHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("URL must be a valid HTTP or HTTPS address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not supported.");
  }
  if (!isPublicHostname(url.hostname)) {
    throw new Error("URL must use a public hostname.");
  }
  return url.href;
}

async function fetchDirectUrl(
  url: string,
  format: OpenUrlFormat,
  signal: AbortSignal | undefined,
  fetchImpl: typeof globalThis.fetch,
): Promise<OpenUrlResult> {
  const response = await fetchImpl(url, {
    credentials: "omit",
    headers: {
      Accept: format === "html"
        ? "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5"
        : "text/markdown, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7",
    },
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) {
    throw new Error(`URL request failed with HTTP ${response.status}.`);
  }
  const finalUrl = normalizePublicHttpUrl(response.url || url);
  const contentType = normalizeContentType(response.headers.get("content-type"));
  assertTextResponse(contentType, format);
  const content = await readBoundedText(response, MAX_OPEN_URL_BYTES);
  if (content.trim().length === 0) {
    throw new Error("The URL returned an empty response.");
  }
  return createDirectOpenUrlResult({
    requested_url: url,
    final_url: finalUrl,
    status: response.status,
    content_type: contentType || "text/plain",
    content,
  }, format);
}

export function createDirectOpenUrlResult(
  value: Omit<OpenUrlResult, "title" | "source">,
  format: OpenUrlFormat,
): OpenUrlResult {
  return {
    ...value,
    title: extractTitle(
      value.content,
      value.final_url,
      value.content_type,
    ),
    content: format === "markdown" && isHtmlContentType(value.content_type)
      ? htmlToMarkdown(value.content)
      : value.content,
    source: "direct",
  };
}

async function fetchReaderMarkdown(
  url: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof globalThis.fetch,
): Promise<OpenUrlResult> {
  const response = await fetchImpl(`${JINA_READER_BASE_URL}${url}`, {
    credentials: "omit",
    headers: {
      Accept: "text/markdown",
      "X-No-Cache": "true",
    },
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Reader fallback failed with HTTP ${response.status}.`);
  }
  const responseText = await readBoundedText(response, MAX_OPEN_URL_BYTES);
  const { title, markdown } = parseReaderMarkdown(responseText, url);
  if (markdown.length === 0) {
    throw new Error("Reader fallback returned no Markdown content.");
  }
  return {
    requested_url: url,
    final_url: url,
    status: response.status,
    content_type: "text/markdown",
    title,
    content: markdown,
    source: "reader",
  };
}

function parseReaderMarkdown(
  value: string,
  url: string,
): { title: string; markdown: string } {
  const marker = "Markdown Content:";
  const markerIndex = value.indexOf(marker);
  const markdown = (markerIndex >= 0
    ? value.slice(markerIndex + marker.length)
    : value
  ).trim();
  const title = value.match(/^Title:\s*(.+)$/mu)?.[1]?.trim() ??
    extractTitle(markdown, url, "text/markdown");
  return { title, markdown };
}

function assertTextResponse(contentType: string, format: OpenUrlFormat) {
  if (format === "html" && !isHtmlContentType(contentType)) {
    throw new Error(
      `URL returned ${contentType || "an unknown content type"}, not HTML.`,
    );
  }
  if (
    contentType &&
    !contentType.startsWith("text/") &&
    contentType !== "application/json" &&
    !contentType.endsWith("+json") &&
    contentType !== "application/xml" &&
    !contentType.endsWith("+xml")
  ) {
    throw new Error(`Unsupported URL content type: ${contentType}.`);
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("URL response exceeded the 2 MB limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error("URL response exceeded the 2 MB limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function extractTitle(
  content: string,
  url: string,
  contentType: string,
): string {
  if (isHtmlContentType(contentType)) {
    const title = content.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1];
    if (title) return decodeHtml(title).replace(/\s+/gu, " ").trim();
  }
  const heading = content.match(/^#{1,2}\s+(.+)$/mu)?.[1];
  if (heading) return heading.replace(/[*_`]/gu, "").trim();
  const parsed = new URL(url);
  return parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname;
}

function htmlToMarkdown(html: string): string {
  const withoutIgnoredElements = html
    .replace(/<!--([\s\S]*?)-->/gu, "")
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/giu, "");
  const withLinks = withoutIgnoredElements.replace(
    /<a\s+[^>]*href=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu,
    (_match, doubleQuotedUrl, singleQuotedUrl, bareUrl, text) => {
      const href = doubleQuotedUrl ?? singleQuotedUrl ?? bareUrl;
      const label = htmlToText(text).trim();
      return href && label ? `[${label}](${href})` : label;
    },
  );
  const withCode = withLinks
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/giu, (_match, code) =>
      `\n\n\`\`\`\n${htmlToText(code).trim()}\n\`\`\`\n\n`
    )
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/giu, (_match, code) =>
      `\`${htmlToText(code).trim()}\``
    );
  const withStructure = withCode
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu, (_match, level, text) =>
      `\n\n${"#".repeat(Number(level))} ${htmlToText(text).trim()}\n\n`
    )
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/giu, (_match, text) =>
      `\n- ${htmlToText(text).trim()}`
    )
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|blockquote|ul|ol)>/giu, "\n\n");
  return htmlToText(withStructure)
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function htmlToText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/gu, ""));
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&#(x[\da-f]+|\d+);/giu, (_match, entity) => {
      const codePoint = entity.startsWith("x") || entity.startsWith("X")
        ? Number.parseInt(entity.slice(1), 16)
        : Number.parseInt(entity, 10);
      return Number.isSafeInteger(codePoint)
        ? String.fromCodePoint(codePoint)
        : "";
    });
}

function normalizeContentType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isHtmlContentType(contentType: string): boolean {
  return contentType === "text/html" ||
    contentType === "application/xhtml+xml";
}

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return false;
  }
  // Avoid private-network bypasses through IPv6 literals. Public host names
  // remain supported, while direct IPv6 URLs can be enabled with DNS-aware
  // validation in a future native fetch service.
  if (normalized.includes(":")) return false;
  const ipv4 = parseIpv4(normalized);
  if (ipv4 === null) return true;
  return !(
    ipv4[0] === 0 ||
    ipv4[0] === 10 ||
    ipv4[0] === 127 ||
    ipv4[0] >= 224 ||
    (ipv4[0] === 169 && ipv4[1] === 254) ||
    (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
    (ipv4[0] === 192 && ipv4[1] === 168)
  );
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return null;
  }
  const values = parts.map(Number);
  return values.every((value) => value >= 0 && value <= 255)
    ? values
    : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
  return new DOMException("URL opening was aborted.", "AbortError");
}
