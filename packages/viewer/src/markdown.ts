import remend from "remend";

const STREAMING_MARKDOWN_OPTIONS = {
  inlineKatex: false,
  katex: false,
  linkMode: "text-only",
} as const;

const EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:"]);
const TRAILING_MARKDOWN_DELIMITER = /(\*+|_+|~+|`+)$/u;

export function prepareAssistantMarkdown(
  source: string,
  isStreaming: boolean,
): string {
  return isStreaming
    ? remend(
        omitUnstableTrailingDelimiter(source),
        STREAMING_MARKDOWN_OPTIONS,
      )
    : source;
}

function omitUnstableTrailingDelimiter(source: string): string {
  const match = TRAILING_MARKDOWN_DELIMITER.exec(source);
  if (!match || match.index === undefined) return source;
  if (match[0].startsWith("~") && match[0].length >= 3) {
    return source;
  }

  let precedingBackslashes = 0;
  for (
    let index = match.index - 1;
    index >= 0 && source[index] === "\\";
    index -= 1
  ) {
    precedingBackslashes += 1;
  }

  return precedingBackslashes % 2 === 1
    ? source
    : source.slice(0, match.index);
}

export function isStreamingAssistantText(
  entryStatus: "streaming" | "complete" | "aborted" | "error",
  isRunActive: boolean,
  isLatestBlock: boolean,
): boolean {
  return entryStatus === "streaming" && isRunActive && isLatestBlock;
}

export function transformMarkdownUrl(
  url: string,
  key: string,
): string | null {
  if (key !== "href") return null;
  if (url.startsWith("#")) return url;

  try {
    const parsed = new URL(url);
    return EXTERNAL_LINK_PROTOCOLS.has(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function isExternalMarkdownUrl(url: string): boolean {
  try {
    return EXTERNAL_LINK_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
