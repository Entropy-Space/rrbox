export const PYTHON_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_PYTHON_TIMEOUT_MS = 15_000;
export const MAX_PYTHON_TIMEOUT_MS = 60_000;
export const MAX_PYTHON_CODE_BYTES = 256 * 1024;
export const MAX_PYTHON_OUTPUT_BYTES = 1024 * 1024;

export type PythonExecutionResult = {
  stdout: string;
  stderr: string;
  error: string | null;
  output_truncated: boolean;
};

export type PythonExecuteRequest = {
  protocol_version: typeof PYTHON_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "python_execute";
  code: string;
  timeout_ms: number;
  max_output_bytes: number;
};

export type PythonCancelRequest = {
  protocol_version: typeof PYTHON_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  kind: "python_cancel";
};

export type PythonRequest = PythonExecuteRequest | PythonCancelRequest;

export type PythonExecuteResponse = {
  protocol_version: typeof PYTHON_PROTOCOL_VERSION;
  request_id: string;
  kind: "python_execute_result";
  result:
    | {
        status: "complete";
        operation_id: string;
        execution: PythonExecutionResult;
      }
    | PythonErrorResult;
};

export type PythonCancelResponse = {
  protocol_version: typeof PYTHON_PROTOCOL_VERSION;
  request_id: string;
  kind: "python_cancel_result";
  result:
    | {
        status: "cancelled";
        operation_id: string;
      }
    | PythonErrorResult;
};

type PythonErrorResult = {
  status: "error";
  code:
    | "invalid_request"
    | "busy"
    | "cancelled"
    | "timeout"
    | "internal";
  message: string;
};

export type PythonResponse = PythonExecuteResponse | PythonCancelResponse;

export function createPythonExecuteRequest(
  code: string,
  options: {
    request_id?: string;
    operation_id?: string;
    timeout_ms?: number;
    max_output_bytes?: number;
  } = {},
): PythonExecuteRequest {
  const request: PythonExecuteRequest = {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id: options.request_id ?? crypto.randomUUID(),
    operation_id: options.operation_id ?? crypto.randomUUID(),
    kind: "python_execute",
    code,
    timeout_ms: options.timeout_ms ?? DEFAULT_PYTHON_TIMEOUT_MS,
    max_output_bytes:
      options.max_output_bytes ?? MAX_PYTHON_OUTPUT_BYTES,
  };
  return parsePythonExecuteRequest(request);
}

export function createPythonCancelRequest(
  operationId: string,
  requestId = crypto.randomUUID(),
): PythonCancelRequest {
  return parsePythonCancelRequest({
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id: requestId,
    operation_id: operationId,
    kind: "python_cancel",
  });
}

export function createPythonErrorResponse(
  request: Pick<PythonRequest, "request_id" | "kind">,
  code: PythonErrorResult["code"],
  message: string,
): PythonResponse {
  const base = {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id: request.request_id,
    result: { status: "error" as const, code, message },
  };
  return request.kind === "python_execute"
    ? { ...base, kind: "python_execute_result" }
    : { ...base, kind: "python_cancel_result" };
}

export function parsePythonRequest(value: unknown): PythonRequest {
  const record = requireRecord(value, "Python request");
  return record.kind === "python_execute"
    ? parsePythonExecuteRequest(record)
    : parsePythonCancelRequest(record);
}

export function parsePythonExecuteRequest(
  value: unknown,
): PythonExecuteRequest {
  const record = requireExactRecord(
    value,
    [
      "protocol_version",
      "request_id",
      "operation_id",
      "kind",
      "code",
      "timeout_ms",
      "max_output_bytes",
    ],
    "Python execute request",
  );
  requireProtocolVersion(record.protocol_version);
  requireKind(record.kind, "python_execute");
  const code = requireString(record.code, "code", true);
  if (new TextEncoder().encode(code).byteLength > MAX_PYTHON_CODE_BYTES) {
    throw new Error(
      `code exceeds ${MAX_PYTHON_CODE_BYTES} UTF-8 bytes.`,
    );
  }
  return {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id: requireString(record.request_id, "request_id"),
    operation_id: requireString(record.operation_id, "operation_id"),
    kind: "python_execute",
    code,
    timeout_ms: requireBoundedInteger(
      record.timeout_ms,
      "timeout_ms",
      1,
      MAX_PYTHON_TIMEOUT_MS,
    ),
    max_output_bytes: requireBoundedInteger(
      record.max_output_bytes,
      "max_output_bytes",
      1,
      MAX_PYTHON_OUTPUT_BYTES,
    ),
  };
}

export function parsePythonCancelRequest(
  value: unknown,
): PythonCancelRequest {
  const record = requireExactRecord(
    value,
    ["protocol_version", "request_id", "operation_id", "kind"],
    "Python cancel request",
  );
  requireProtocolVersion(record.protocol_version);
  requireKind(record.kind, "python_cancel");
  return {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id: requireString(record.request_id, "request_id"),
    operation_id: requireString(record.operation_id, "operation_id"),
    kind: "python_cancel",
  };
}

export function parsePythonResponse(value: unknown): PythonResponse {
  const record = requireRecord(value, "Python response");
  if (record.kind === "python_execute_result") {
    return parsePythonExecuteResponse(record);
  }
  if (record.kind === "python_cancel_result") {
    return parsePythonCancelResponse(record);
  }
  throw new Error("Python response has an invalid kind.");
}

export function parsePythonExecuteResponse(
  value: unknown,
): PythonExecuteResponse {
  const record = requireExactRecord(
    value,
    ["protocol_version", "request_id", "kind", "result"],
    "Python execute response",
  );
  requireProtocolVersion(record.protocol_version);
  requireKind(record.kind, "python_execute_result");
  const result = parseResponseResult(record.result, true);
  return {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id: requireString(record.request_id, "request_id"),
    kind: "python_execute_result",
    result,
  };
}

export function parsePythonCancelResponse(
  value: unknown,
): PythonCancelResponse {
  const record = requireExactRecord(
    value,
    ["protocol_version", "request_id", "kind", "result"],
    "Python cancel response",
  );
  requireProtocolVersion(record.protocol_version);
  requireKind(record.kind, "python_cancel_result");
  const result = parseResponseResult(record.result, false);
  return {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id: requireString(record.request_id, "request_id"),
    kind: "python_cancel_result",
    result,
  };
}

function parseResponseResult(
  value: unknown,
  execute: true,
): PythonExecuteResponse["result"];
function parseResponseResult(
  value: unknown,
  execute: false,
): PythonCancelResponse["result"];
function parseResponseResult(
  value: unknown,
  execute: boolean,
): PythonExecuteResponse["result"] | PythonCancelResponse["result"] {
  const record = requireRecord(value, "Python response result");
  if (record.status === "error") {
    const exact = requireExactRecord(
      record,
      ["status", "code", "message"],
      "Python error result",
    );
    const validCodes = new Set([
      "invalid_request",
      "busy",
      "cancelled",
      "timeout",
      "internal",
    ]);
    if (typeof exact.code !== "string" || !validCodes.has(exact.code)) {
      throw new Error("Python error result has an invalid code.");
    }
    return {
      status: "error",
      code: exact.code as PythonErrorResult["code"],
      message: requireString(exact.message, "message"),
    };
  }
  if (execute && record.status === "complete") {
    const exact = requireExactRecord(
      record,
      ["status", "operation_id", "execution"],
      "Python complete result",
    );
    return {
      status: "complete",
      operation_id: requireString(
        exact.operation_id,
        "operation_id",
      ),
      execution: parseExecutionResult(exact.execution),
    };
  }
  if (!execute && record.status === "cancelled") {
    const exact = requireExactRecord(
      record,
      ["status", "operation_id"],
      "Python cancelled result",
    );
    return {
      status: "cancelled",
      operation_id: requireString(
        exact.operation_id,
        "operation_id",
      ),
    };
  }
  throw new Error("Python response result has an invalid status.");
}

function parseExecutionResult(value: unknown): PythonExecutionResult {
  const record = requireExactRecord(
    value,
    ["stdout", "stderr", "error", "output_truncated"],
    "Python execution result",
  );
  if (record.error !== null && typeof record.error !== "string") {
    throw new Error("Python execution error must be a string or null.");
  }
  if (typeof record.output_truncated !== "boolean") {
    throw new Error("Python output_truncated must be a boolean.");
  }
  return {
    stdout: requireString(record.stdout, "stdout", true),
    stderr: requireString(record.stderr, "stderr", true),
    error: record.error,
    output_truncated: record.output_truncated,
  };
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const actualFields = Object.keys(record);
  if (
    actualFields.length !== fields.length ||
    fields.some((field) => !(field in record))
  ) {
    throw new Error(`${label} has invalid fields.`);
  }
  return record;
}

function requireProtocolVersion(value: unknown): void {
  if (value !== PYTHON_PROTOCOL_VERSION) {
    throw new Error("Unsupported Python protocol version.");
  }
}

function requireKind<TKind extends PythonRequest["kind"] | PythonResponse["kind"]>(
  value: unknown,
  expected: TKind,
): asserts value is TKind {
  if (value !== expected) {
    throw new Error(`Expected Python message kind ${expected}.`);
  }
}

function requireString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}
