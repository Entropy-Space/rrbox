import type { WebSearchResponse } from "./web-research-engine.ts";

export const NATIVE_WEB_SEARCH_PROTOCOL_VERSION = 1 as const;
const MAX_NATIVE_WEB_SEARCH_QUERY_BYTES = 16 * 1024;

export type NativeWebSearchExecuteRequest = {
  protocol_version: typeof NATIVE_WEB_SEARCH_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "web_search_execute";
  provider_id: "anysearch";
  query: string;
  num_results: number;
  include_content: boolean;
  timeout_ms: number;
};

export type NativeWebSearchCancelRequest = {
  protocol_version: typeof NATIVE_WEB_SEARCH_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "web_search_cancel";
};

export type NativeWebSearchRequest =
  | NativeWebSearchExecuteRequest
  | NativeWebSearchCancelRequest;

export type NativeWebSearchExecuteResponse = {
  protocol_version: typeof NATIVE_WEB_SEARCH_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "web_search_execute_result";
} & (
  | {
      success: true;
      response: WebSearchResponse;
    }
  | {
      success: false;
      code:
        | "invalid_request"
        | "network"
        | "timeout"
        | "aborted"
        | "provider"
        | "internal";
      message: string;
    }
);

export type NativeWebSearchCancelResponse = {
  protocol_version: typeof NATIVE_WEB_SEARCH_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "web_search_cancel_result";
  cancelled: boolean;
};

export type NativeWebSearchResponse =
  | NativeWebSearchExecuteResponse
  | NativeWebSearchCancelResponse;

export function parseNativeWebSearchRequest(
  value: unknown,
): NativeWebSearchRequest {
  const record = requireRecord(value, "Native web search request");
  requireProtocol(record);
  const kind = requireString(record, "kind");
  const base = {
    protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
    request_id: requireIdentifier(record, "request_id"),
    operation_id: requireIdentifier(record, "operation_id"),
  };
  if (kind === "web_search_cancel") {
    assertExactKeys(record, [
      "protocol_version",
      "request_id",
      "operation_id",
      "kind",
    ]);
    return { ...base, kind };
  }
  if (kind !== "web_search_execute") {
    throw new Error("Invalid native web search request kind.");
  }
  assertExactKeys(record, [
    "protocol_version",
    "request_id",
    "operation_id",
    "kind",
    "provider_id",
    "query",
    "num_results",
    "include_content",
    "timeout_ms",
  ]);
  if (record.provider_id !== "anysearch") {
    throw new Error("Invalid native web search provider.");
  }
  const query = requireString(record, "query").trim();
  if (
    query.length === 0 ||
    new TextEncoder().encode(query).byteLength >
      MAX_NATIVE_WEB_SEARCH_QUERY_BYTES
  ) {
    throw new Error("Native web search query is out of bounds.");
  }
  return {
    ...base,
    kind,
    provider_id: "anysearch",
    query,
    num_results: requireBoundedInteger(
      record,
      "num_results",
      1,
      20,
    ),
    include_content: requireBoolean(record, "include_content"),
    timeout_ms: requireBoundedInteger(
      record,
      "timeout_ms",
      5_000,
      60_000,
    ),
  };
}

export function parseNativeWebSearchResponse(
  value: unknown,
): NativeWebSearchResponse {
  const record = requireRecord(value, "Native web search response");
  requireProtocol(record);
  const kind = requireString(record, "kind");
  const base = {
    protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
    request_id: requireIdentifier(record, "request_id"),
    operation_id: requireIdentifier(record, "operation_id"),
  };
  if (kind === "web_search_cancel_result") {
    assertExactKeys(record, [
      "protocol_version",
      "request_id",
      "operation_id",
      "kind",
      "cancelled",
    ]);
    return {
      ...base,
      kind,
      cancelled: requireBoolean(record, "cancelled"),
    };
  }
  if (kind !== "web_search_execute_result") {
    throw new Error("Invalid native web search response kind.");
  }
  const success = requireBoolean(record, "success");
  if (!success) {
    assertExactKeys(record, [
      "protocol_version",
      "request_id",
      "operation_id",
      "kind",
      "success",
      "code",
      "message",
    ]);
    const code = requireString(record, "code");
    if (
      code !== "invalid_request" &&
      code !== "network" &&
      code !== "timeout" &&
      code !== "aborted" &&
      code !== "provider" &&
      code !== "internal"
    ) {
      throw new Error("Invalid native web search error code.");
    }
    return {
      ...base,
      kind,
      success: false,
      code,
      message: requireString(record, "message"),
    };
  }
  assertExactKeys(record, [
    "protocol_version",
    "request_id",
    "operation_id",
    "kind",
    "success",
    "response",
  ]);
  return {
    ...base,
    kind,
    success: true,
    response: parseSearchResponse(record.response),
  };
}

export function createNativeWebSearchErrorResponse(
  request: Pick<
    NativeWebSearchRequest,
    "request_id" | "operation_id" | "kind"
  >,
  code: Extract<
    NativeWebSearchExecuteResponse,
    { success: false }
  >["code"],
  message: string,
): NativeWebSearchExecuteResponse {
  return {
    protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
    request_id: request.request_id,
    operation_id: request.operation_id,
    kind: "web_search_execute_result",
    success: false,
    code,
    message,
  };
}

function parseSearchResponse(value: unknown): WebSearchResponse {
  const record = requireRecord(value, "Native web search result");
  assertExactKeys(record, [
    "query",
    "provider",
    "answer",
    "sources",
  ]);
  if (record.provider !== "anysearch") {
    throw new Error("Invalid native web search result provider.");
  }
  if (!Array.isArray(record.sources) || record.sources.length > 20) {
    throw new Error("Native web search sources are out of bounds.");
  }
  return {
    query: requireBoundedString(record, "query", 16 * 1024),
    provider: "anysearch",
    answer: requireBoundedString(record, "answer", 256 * 1024, true),
    sources: record.sources.map((value) => {
      const source = requireRecord(value, "Native web search source");
      assertExactKeys(source, [
        "title",
        "url",
        "snippet",
      ], ["content"]);
      const url = requireBoundedString(source, "url", 8 * 1024);
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Native web search source URL must use HTTP(S).");
      }
      const content = optionalString(source, "content");
      return {
        title: requireBoundedString(source, "title", 2_048),
        url,
        snippet: requireBoundedString(
          source,
          "snippet",
          64 * 1024,
          true,
        ),
        ...(content === undefined
          ? {}
          : {
              content: requireBoundedString(
                source,
                "content",
                256 * 1024,
                true,
              ),
            }),
      };
    }),
  };
}

function requireProtocol(record: Record<string, unknown>): void {
  if (
    record.protocol_version !== NATIVE_WEB_SEARCH_PROTOCOL_VERSION
  ) {
    throw new Error("Unsupported native web search protocol version.");
  }
}

function requireRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const allowed = new Set([...keys, ...optionalKeys]);
  if (
    keys.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("Native web search message has unexpected fields.");
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`Native web search ${key} must be a string.`);
  }
  return result;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string") {
    throw new Error(`Native web search ${key} must be a string.`);
  }
  return result;
}

function requireBoundedString(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
  allowEmpty = false,
): string {
  const result = value[key];
  if (
    typeof result !== "string" ||
    (!allowEmpty && result.length === 0) ||
    result.length > maximum
  ) {
    throw new Error(`Native web search ${key} is out of bounds.`);
  }
  return result;
}

function requireIdentifier(
  value: Record<string, unknown>,
  key: string,
): string {
  const result = requireString(value, key);
  if (result.length > 256) {
    throw new Error(`Native web search ${key} is out of bounds.`);
  }
  return result;
}

function requireBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const result = value[key];
  if (typeof result !== "boolean") {
    throw new Error(`Native web search ${key} must be boolean.`);
  }
  return result;
}

function requireBoundedInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const result = value[key];
  if (
    typeof result !== "number" ||
    !Number.isInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new Error(`Native web search ${key} is out of bounds.`);
  }
  return result;
}
