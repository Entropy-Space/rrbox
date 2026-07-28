import {
  NATIVE_OPENAI_PROVIDER_ID,
  NATIVE_PROVIDER_PROTOCOL_VERSION,
  type NativeProviderBodyEvent,
  type NativeProviderBodyFinishedEvent,
  type NativeProviderBrokerMessage,
  type NativeProviderCancelRequest,
  type NativeProviderCancelResponse,
  type NativeProviderConnectionError,
  type NativeProviderEndpoint,
  type NativeProviderError,
  type NativeProviderErrorCode,
  type NativeProviderErrorResult,
  type NativeProviderFetchRequest,
  type NativeProviderFetchResponse,
  type NativeProviderMethod,
  type NativeProviderRequest,
  type NativeProviderResponse,
} from "./wire-types.ts";

const NATIVE_PROVIDER_ERROR_CODES =
  new Set<NativeProviderErrorCode>([
    "invalid_request",
    "provider_unavailable",
    "provider_response_too_large",
    "internal",
  ]);

export function parseNativeProviderRequest(
  value: unknown,
): NativeProviderRequest {
  const record = parseVersionedRecord(value, "Native provider request");
  return "provider_id" in record
    ? parseNativeProviderFetchRequest(record)
    : parseNativeProviderCancelRequest(record);
}

export function parseNativeProviderFetchRequest(
  value: unknown,
): NativeProviderFetchRequest {
  const record = parseVersionedRecord(
    value,
    "Native provider fetch request",
  );
  assertExactFields(
    record,
    [
      "protocol_version",
      "request_id",
      "operation_id",
      "provider_id",
      "endpoint",
      "method",
    ],
    ["body"],
  );

  const providerId = requireString(record, "provider_id");
  if (providerId !== NATIVE_OPENAI_PROVIDER_ID) {
    throw new Error(`Unsupported native provider: ${providerId}`);
  }
  const endpoint = parseEndpoint(record.endpoint);
  const method = parseMethod(record.method);
  const body =
    record.body === undefined
      ? undefined
      : requireString(record, "body", true);

  if (endpoint === "models" && (method !== "get" || body !== undefined)) {
    throw new Error("The models endpoint requires GET without a body.");
  }
  if (
    endpoint === "chat_completions" &&
    (method !== "post" || body === undefined)
  ) {
    throw new Error(
      "The chat_completions endpoint requires POST with a body.",
    );
  }

  return {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    request_id: requireIdentifier(record, "request_id"),
    operation_id: requireIdentifier(record, "operation_id"),
    provider_id: NATIVE_OPENAI_PROVIDER_ID,
    endpoint,
    method,
    ...(body === undefined ? {} : { body }),
  };
}

export function parseNativeProviderCancelRequest(
  value: unknown,
): NativeProviderCancelRequest {
  const record = parseVersionedRecord(
    value,
    "Native provider cancel request",
  );
  assertExactFields(record, [
    "protocol_version",
    "request_id",
    "operation_id",
  ]);
  return {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    request_id: requireIdentifier(record, "request_id"),
    operation_id: requireIdentifier(record, "operation_id"),
  };
}

export function parseNativeProviderResponse(
  value: unknown,
): NativeProviderResponse {
  const record = parseVersionedRecord(value, "Native provider response");
  assertExactFields(record, [
    "protocol_version",
    "request_id",
    "result",
  ]);
  const result = requireRecord(record.result, "result");

  switch (result.kind) {
    case "fetch_started":
      assertExactFields(result, ["kind", "operation_id"]);
      return {
        protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
        request_id: requireIdentifier(record, "request_id"),
        result: {
          kind: "fetch_started",
          operation_id: requireIdentifier(result, "operation_id"),
        },
      };
    case "operation_cancelled":
      assertExactFields(result, [
        "kind",
        "operation_id",
        "was_active",
      ]);
      return {
        protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
        request_id: requireIdentifier(record, "request_id"),
        result: {
          kind: "operation_cancelled",
          operation_id: requireIdentifier(result, "operation_id"),
          was_active: requireBoolean(result, "was_active"),
        },
      };
    case "error":
      return {
        protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
        request_id: requireIdentifier(record, "request_id"),
        result: parseErrorResult(result),
      };
    default:
      throw new Error(
        `Unknown native provider result: ${String(result.kind)}`,
      );
  }
}

export function parseNativeProviderFetchResponse(
  value: unknown,
): NativeProviderFetchResponse {
  const response = parseNativeProviderResponse(value);
  if (
    response.result.kind !== "fetch_started" &&
    response.result.kind !== "error"
  ) {
    throw new Error(
      "Native provider fetch returned a cancellation result.",
    );
  }
  return {
    protocol_version: response.protocol_version,
    request_id: response.request_id,
    result: response.result,
  };
}

export function parseNativeProviderCancelResponse(
  value: unknown,
): NativeProviderCancelResponse {
  const response = parseNativeProviderResponse(value);
  if (
    response.result.kind !== "operation_cancelled" &&
    response.result.kind !== "error"
  ) {
    throw new Error("Native provider cancel returned a fetch result.");
  }
  return {
    protocol_version: response.protocol_version,
    request_id: response.request_id,
    result: response.result,
  };
}

export function parseNativeProviderBodyEvent(
  value: unknown,
): NativeProviderBodyEvent {
  const record = parseVersionedRecord(value, "Native provider body event");
  const base = {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    operation_id: requireIdentifier(record, "operation_id"),
    event_index: requireNonNegativeInteger(record, "event_index"),
  } as const;

  switch (record.kind) {
    case "response_started":
      assertExactFields(record, [
        "protocol_version",
        "operation_id",
        "event_index",
        "kind",
        "status",
        "status_text",
        "headers",
      ]);
      return {
        ...base,
        kind: "response_started",
        status: requireHttpStatus(record, "status"),
        status_text: requireHttpStatusText(record, "status_text"),
        headers: parseHeaders(record.headers),
      };
    case "body_chunk":
      assertExactFields(record, [
        "protocol_version",
        "operation_id",
        "event_index",
        "kind",
        "chunk_base64",
      ]);
      return {
        ...base,
        kind: "body_chunk",
        chunk_base64: requireCanonicalBase64(record, "chunk_base64"),
      };
    case "body_finished":
      return parseBodyFinishedEvent(record, base);
    default:
      throw new Error(
        `Unknown native provider body event: ${String(record.kind)}`,
      );
  }
}

export function parseNativeProviderConnectionError(
  value: unknown,
): NativeProviderConnectionError {
  const record = parseVersionedRecord(
    value,
    "Native provider connection error",
  );
  assertExactFields(record, [
    "protocol_version",
    "kind",
    "error_message",
  ]);
  if (record.kind !== "connection_error") {
    throw new Error("Invalid native provider connection error kind.");
  }
  return {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    kind: "connection_error",
    error_message: requireString(record, "error_message"),
  };
}

export function parseNativeProviderBrokerMessage(
  value: unknown,
): NativeProviderBrokerMessage {
  const record = parseVersionedRecord(
    value,
    "Native provider broker message",
  );
  if (record.kind === "connection_error") {
    return parseNativeProviderConnectionError(record);
  }
  if ("event_index" in record) {
    return parseNativeProviderBodyEvent(record);
  }
  return parseNativeProviderResponse(record);
}

export function createNativeProviderErrorResponse(
  requestId: string,
  error: NativeProviderError,
): NativeProviderFetchResponse | NativeProviderCancelResponse {
  return {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    request_id: requireIdentifierValue(requestId, "request_id"),
    result: {
      kind: "error",
      error: parseNativeProviderError(error),
    },
  };
}

export function createNativeProviderConnectionError(
  errorMessage: string,
): NativeProviderConnectionError {
  return {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    kind: "connection_error",
    error_message: requireNonEmptyString(
      errorMessage,
      "error_message",
    ),
  };
}

export function parseNativeProviderError(
  value: unknown,
): NativeProviderError {
  const record = requireRecord(value, "error");
  assertExactFields(record, ["code", "message"]);
  if (
    typeof record.code !== "string" ||
    !NATIVE_PROVIDER_ERROR_CODES.has(
      record.code as NativeProviderErrorCode,
    )
  ) {
    throw new Error("Invalid native provider error code.");
  }
  return {
    code: record.code as NativeProviderErrorCode,
    message: requireString(record, "message"),
  };
}

export class NativeProviderBodyEventSequenceValidator {
  private nextEventIndex = 0;
  private responseStarted = false;
  private finished = false;

  accept(value: unknown): NativeProviderBodyEvent {
    if (this.finished) {
      throw new Error("Native provider emitted an event after completion.");
    }
    const event = parseNativeProviderBodyEvent(value);
    if (event.event_index !== this.nextEventIndex) {
      throw new Error(
        `Expected native provider event_index ${this.nextEventIndex}, received ${event.event_index}.`,
      );
    }

    switch (event.kind) {
      case "response_started":
        if (this.responseStarted) {
          throw new Error(
            "Native provider emitted response_started more than once.",
          );
        }
        this.responseStarted = true;
        break;
      case "body_chunk":
        if (!this.responseStarted) {
          throw new Error(
            "Native provider emitted a body chunk before response_started.",
          );
        }
        break;
      case "body_finished":
        if (!this.responseStarted && event.status === "complete") {
          throw new Error(
            "Native provider completed before response_started.",
          );
        }
        this.finished = true;
        break;
    }
    this.nextEventIndex += 1;
    return event;
  }

  get is_finished(): boolean {
    return this.finished;
  }

  get next_event_index(): number {
    return this.nextEventIndex;
  }
}

function parseErrorResult(
  value: Record<string, unknown>,
): NativeProviderErrorResult {
  assertExactFields(value, ["kind", "error"]);
  return {
    kind: "error",
    error: parseNativeProviderError(value.error),
  };
}

function parseBodyFinishedEvent(
  record: Record<string, unknown>,
  base: {
    protocol_version: typeof NATIVE_PROVIDER_PROTOCOL_VERSION;
    operation_id: string;
    event_index: number;
  },
): NativeProviderBodyFinishedEvent {
  assertExactFields(
    record,
    [
      "protocol_version",
      "operation_id",
      "event_index",
      "kind",
      "status",
    ],
    ["error_message"],
  );
  const status = record.status;
  if (
    status !== "complete" &&
    status !== "aborted" &&
    status !== "error"
  ) {
    throw new Error("Invalid native provider body completion status.");
  }
  const errorMessage =
    record.error_message === undefined
      ? undefined
      : requireString(record, "error_message");
  if (status === "error" && errorMessage === undefined) {
    throw new Error(
      "An errored native provider body requires error_message.",
    );
  }
  if (status !== "error" && errorMessage !== undefined) {
    throw new Error(
      "Only an errored native provider body may include error_message.",
    );
  }
  return {
    ...base,
    kind: "body_finished",
    status,
    ...(errorMessage === undefined
      ? {}
      : { error_message: errorMessage }),
  };
}

function parseEndpoint(value: unknown): NativeProviderEndpoint {
  if (value !== "models" && value !== "chat_completions") {
    throw new Error("Invalid native provider endpoint.");
  }
  return value;
}

function parseMethod(value: unknown): NativeProviderMethod {
  if (value !== "get" && value !== "post") {
    throw new Error("Invalid native provider method.");
  }
  return value;
}

function parseHeaders(value: unknown): Record<string, string> {
  const record = requireRecord(value, "headers");
  const entries = Object.entries(record).map(([name, headerValue]) => {
    if (!name || name !== name.toLowerCase()) {
      throw new Error(
        "Native provider response header names must be lowercase.",
      );
    }
    if (typeof headerValue !== "string") {
      throw new Error(
        `Native provider response header ${name} must be a string.`,
      );
    }
    return [name, headerValue] as [string, string];
  });
  try {
    new Headers(entries);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Invalid native provider response headers: ${error.message}`
        : "Invalid native provider response headers.",
    );
  }
  return Object.fromEntries(entries);
}

function parseVersionedRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  if (record.protocol_version !== NATIVE_PROVIDER_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported native provider protocol version: ${String(record.protocol_version)}`,
    );
  }
  return record;
}

function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const field of required) {
    if (!(field in value)) {
      throw new Error(`Missing native provider field: ${field}.`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`Unknown native provider field: ${field}.`);
    }
  }
}

function requireIdentifier(
  value: Record<string, unknown>,
  field: string,
): string {
  return requireIdentifierValue(value[field], field);
}

function requireIdentifierValue(value: unknown, field: string): string {
  const identifier = requireNonEmptyString(value, field);
  if (identifier.trim() !== identifier) {
    throw new Error(`${field} must not contain surrounding whitespace.`);
  }
  return identifier;
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  allowEmpty = false,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    (!allowEmpty && candidate.length === 0)
  ) {
    throw new Error(
      `${field} must be ${allowEmpty ? "a string" : "a non-empty string"}.`,
    );
  }
  return candidate;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireBoolean(
  value: Record<string, unknown>,
  field: string,
): boolean {
  if (typeof value[field] !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value[field];
}

function requireNonNegativeInteger(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = value[field];
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 0
  ) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return candidate;
}

function requireHttpStatus(
  value: Record<string, unknown>,
  field: string,
): number {
  const status = requireNonNegativeInteger(value, field);
  if (status < 200 || status > 599) {
    throw new Error(`${field} must be between 200 and 599.`);
  }
  return status;
}

function requireHttpStatusText(
  value: Record<string, unknown>,
  field: string,
): string {
  const statusText = requireString(value, field, true);
  if (/[\r\n]/u.test(statusText)) {
    throw new Error(`${field} must not contain line breaks.`);
  }
  return statusText;
}

function requireCanonicalBase64(
  value: Record<string, unknown>,
  field: string,
): string {
  const encoded = requireString(value, field);
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    throw new Error(`${field} must be canonical base64.`);
  }
  return encoded;
}
