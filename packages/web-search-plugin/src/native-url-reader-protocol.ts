export const NATIVE_URL_READER_PROTOCOL_VERSION = 1 as const;

const MAX_IDENTIFIER_BYTES = 256;
const MAX_URL_BYTES = 8 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;

export type NativeUrlReaderOpenRequest = {
  protocol_version: typeof NATIVE_URL_READER_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "url_reader_open";
  url: string;
  format: "html" | "markdown";
  timeout_ms: number;
};

export type NativeUrlReaderCancelRequest = {
  protocol_version: typeof NATIVE_URL_READER_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "url_reader_cancel";
};

export type NativeUrlReaderRequest =
  | NativeUrlReaderOpenRequest
  | NativeUrlReaderCancelRequest;

export type NativeUrlReaderOpenResponse = {
  protocol_version: typeof NATIVE_URL_READER_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "url_reader_open_result";
} & (
  | {
      success: true;
      result: NativeUrlReaderResult;
    }
  | {
      success: false;
      code: NativeUrlReaderErrorCode;
      message: string;
    }
);

export type NativeUrlReaderResult = {
  requested_url: string;
  final_url: string;
  status: number;
  content_type: string;
  content: string;
};

export type NativeUrlReaderErrorCode =
  | "invalid_request"
  | "network"
  | "timeout"
  | "aborted"
  | "unsupported"
  | "internal";

export type NativeUrlReaderCancelResponse = {
  protocol_version: typeof NATIVE_URL_READER_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "url_reader_cancel_result";
  cancelled: boolean;
};

export type NativeUrlReaderResponse =
  | NativeUrlReaderOpenResponse
  | NativeUrlReaderCancelResponse;

export function parseNativeUrlReaderRequest(
  value: unknown,
): NativeUrlReaderRequest {
  const record = requireRecord(value, "Native URL reader request");
  requireProtocol(record);
  const base = {
    protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
    request_id: requireIdentifier(record, "request_id"),
    operation_id: requireIdentifier(record, "operation_id"),
  };
  const kind = requireString(record, "kind");
  if (kind === "url_reader_cancel") {
    assertExactKeys(record, [
      "protocol_version",
      "request_id",
      "operation_id",
      "kind",
    ]);
    return { ...base, kind };
  }
  if (kind !== "url_reader_open") {
    throw new Error("Invalid native URL reader request kind.");
  }
  assertExactKeys(record, [
    "protocol_version",
    "request_id",
    "operation_id",
    "kind",
    "url",
    "format",
    "timeout_ms",
  ]);
  const url = requireString(record, "url").trim();
  if (
    url.length === 0 ||
    new TextEncoder().encode(url).byteLength > MAX_URL_BYTES
  ) {
    throw new Error("Native URL reader URL is out of bounds.");
  }
  const format = record.format;
  if (format !== "html" && format !== "markdown") {
    throw new Error("Invalid native URL reader format.");
  }
  return {
    ...base,
    kind,
    url,
    format,
    timeout_ms: requireBoundedInteger(
      record,
      "timeout_ms",
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
  };
}

export function parseNativeUrlReaderResponse(
  value: unknown,
): NativeUrlReaderResponse {
  const record = requireRecord(value, "Native URL reader response");
  requireProtocol(record);
  const base = {
    protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
    request_id: requireIdentifier(record, "request_id"),
    operation_id: requireIdentifier(record, "operation_id"),
  };
  const kind = requireString(record, "kind");
  if (kind === "url_reader_cancel_result") {
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
  if (kind !== "url_reader_open_result") {
    throw new Error("Invalid native URL reader response kind.");
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
    return {
      ...base,
      kind,
      success,
      code: parseErrorCode(requireString(record, "code")),
      message: requireBoundedString(record, "message", 1_000),
    };
  }
  assertExactKeys(record, [
    "protocol_version",
    "request_id",
    "operation_id",
    "kind",
    "success",
    "result",
  ]);
  return {
    ...base,
    kind,
    success,
    result: parseResult(record.result),
  };
}

export function createNativeUrlReaderErrorResponse(
  request: Pick<
    NativeUrlReaderRequest,
    "request_id" | "operation_id"
  >,
  code: NativeUrlReaderErrorCode,
  message: string,
): NativeUrlReaderOpenResponse {
  return {
    protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
    request_id: request.request_id,
    operation_id: request.operation_id,
    kind: "url_reader_open_result",
    success: false,
    code,
    message: message.slice(0, 1_000),
  };
}

function parseResult(value: unknown): NativeUrlReaderResult {
  const record = requireRecord(value, "Native URL reader result");
  assertExactKeys(record, [
    "requested_url",
    "final_url",
    "status",
    "content_type",
    "content",
  ]);
  const content = requireBoundedString(
    record,
    "content",
    MAX_CONTENT_BYTES,
  );
  return {
    requested_url: requireBoundedString(record, "requested_url", MAX_URL_BYTES),
    final_url: requireBoundedString(record, "final_url", MAX_URL_BYTES),
    status: requireBoundedInteger(record, "status", 100, 599),
    content_type: requireBoundedString(record, "content_type", 256),
    content,
  };
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireProtocol(value: Record<string, unknown>): void {
  if (value.protocol_version !== NATIVE_URL_READER_PROTOCOL_VERSION) {
    throw new Error("Unsupported native URL reader protocol version.");
  }
}

function requireIdentifier(
  value: Record<string, unknown>,
  field: string,
): string {
  return requireBoundedString(value, field, MAX_IDENTIFIER_BYTES);
}

function requireString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") {
    throw new Error(`Native URL reader ${field} must be a string.`);
  }
  return candidate;
}

function requireBoundedString(
  value: Record<string, unknown>,
  field: string,
  maximumBytes: number,
): string {
  const candidate = requireString(value, field);
  const bytes = new TextEncoder().encode(candidate).byteLength;
  if (candidate.length === 0 || bytes > maximumBytes) {
    throw new Error(`Native URL reader ${field} is out of bounds.`);
  }
  return candidate;
}

function requireBoolean(value: Record<string, unknown>, field: string): boolean {
  if (typeof value[field] !== "boolean") {
    throw new Error(`Native URL reader ${field} must be a boolean.`);
  }
  return value[field];
}

function requireBoundedInteger(
  value: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const candidate = value[field];
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(`Native URL reader ${field} is out of bounds.`);
  }
  return candidate;
}

function parseErrorCode(value: string): NativeUrlReaderErrorCode {
  if (
    value === "invalid_request" ||
    value === "network" ||
    value === "timeout" ||
    value === "aborted" ||
    value === "unsupported" ||
    value === "internal"
  ) {
    return value;
  }
  throw new Error("Invalid native URL reader error code.");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error("Native URL reader message has unexpected fields.");
  }
}
