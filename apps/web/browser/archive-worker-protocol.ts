export type ArchiveWorkspaceFile = {
  path: string;
  content: string;
};

export const ARCHIVE_WORKER_PROTOCOL_VERSION = 1 as const;

export type DecodeWorkspaceArchiveRequest = {
  protocol_version: typeof ARCHIVE_WORKER_PROTOCOL_VERSION;
  type: "decode_workspace_archive";
  archive_bytes: ArrayBuffer;
};

export type EncodeWorkspaceArchiveRequest = {
  protocol_version: typeof ARCHIVE_WORKER_PROTOCOL_VERSION;
  type: "encode_workspace_archive";
  files: ArchiveWorkspaceFile[];
};

export type ArchiveWorkerRequest =
  | DecodeWorkspaceArchiveRequest
  | EncodeWorkspaceArchiveRequest;

export type WorkspaceArchiveDecodedResponse = {
  protocol_version: typeof ARCHIVE_WORKER_PROTOCOL_VERSION;
  type: "workspace_archive_decoded";
  files: ArchiveWorkspaceFile[];
};

export type WorkspaceArchiveEncodedResponse = {
  protocol_version: typeof ARCHIVE_WORKER_PROTOCOL_VERSION;
  type: "workspace_archive_encoded";
  archive_bytes: ArrayBuffer;
};

export type ArchiveWorkerErrorCode =
  | "invalid_input"
  | "invalid_archive"
  | "unsupported_format"
  | "limit_exceeded"
  | "workspace_changed"
  | "invalid_worker_message"
  | "archive_worker_failed";

export type WorkspaceArchiveErrorResponse = {
  protocol_version: typeof ARCHIVE_WORKER_PROTOCOL_VERSION;
  type: "workspace_archive_error";
  error_code: ArchiveWorkerErrorCode;
  error_message: string;
};

export type ArchiveWorkerResponse =
  | WorkspaceArchiveDecodedResponse
  | WorkspaceArchiveEncodedResponse
  | WorkspaceArchiveErrorResponse;

const ERROR_CODES = new Set<ArchiveWorkerErrorCode>([
  "invalid_input",
  "invalid_archive",
  "unsupported_format",
  "limit_exceeded",
  "workspace_changed",
  "invalid_worker_message",
  "archive_worker_failed",
]);

export class ArchiveWorkerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveWorkerProtocolError";
  }
}

export function createDecodeWorkspaceArchiveRequest(
  archiveBytes: ArrayBuffer,
): DecodeWorkspaceArchiveRequest {
  if (!(archiveBytes instanceof ArrayBuffer)) {
    throw new ArchiveWorkerProtocolError(
      "Workspace archive bytes must be an ArrayBuffer.",
    );
  }
  return {
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "decode_workspace_archive",
    archive_bytes: archiveBytes,
  };
}

export function createEncodeWorkspaceArchiveRequest(
  files: readonly ArchiveWorkspaceFile[],
): EncodeWorkspaceArchiveRequest {
  return {
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "encode_workspace_archive",
    files: copyWorkspaceFiles(files),
  };
}

export function parseArchiveWorkerRequest(
  value: unknown,
): ArchiveWorkerRequest {
  if (
    !isRecord(value) ||
    value.protocol_version !== ARCHIVE_WORKER_PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    throw invalidMessage("request");
  }
  if (
    value.type === "decode_workspace_archive" &&
    hasExactKeys(value, [
      "protocol_version",
      "type",
      "archive_bytes",
    ]) &&
    value.archive_bytes instanceof ArrayBuffer
  ) {
    return value as DecodeWorkspaceArchiveRequest;
  }
  if (
    value.type === "encode_workspace_archive" &&
    hasExactKeys(value, ["protocol_version", "type", "files"]) &&
    isWorkspaceFileArray(value.files)
  ) {
    return value as EncodeWorkspaceArchiveRequest;
  }
  throw invalidMessage("request");
}

export function parseArchiveWorkerResponse(
  value: unknown,
): ArchiveWorkerResponse {
  if (
    !isRecord(value) ||
    value.protocol_version !== ARCHIVE_WORKER_PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    throw invalidMessage("response");
  }
  if (
    value.type === "workspace_archive_decoded" &&
    hasExactKeys(value, ["protocol_version", "type", "files"]) &&
    isWorkspaceFileArray(value.files)
  ) {
    return value as WorkspaceArchiveDecodedResponse;
  }
  if (
    value.type === "workspace_archive_encoded" &&
    hasExactKeys(value, [
      "protocol_version",
      "type",
      "archive_bytes",
    ]) &&
    value.archive_bytes instanceof ArrayBuffer
  ) {
    return value as WorkspaceArchiveEncodedResponse;
  }
  if (
    value.type === "workspace_archive_error" &&
    hasExactKeys(value, [
      "protocol_version",
      "type",
      "error_code",
      "error_message",
    ]) &&
    typeof value.error_code === "string" &&
    ERROR_CODES.has(value.error_code as ArchiveWorkerErrorCode) &&
    typeof value.error_message === "string" &&
    value.error_message.length > 0
  ) {
    return value as WorkspaceArchiveErrorResponse;
  }
  throw invalidMessage("response");
}

function copyWorkspaceFiles(
  files: readonly ArchiveWorkspaceFile[],
): ArchiveWorkspaceFile[] {
  if (!isWorkspaceFileArray(files)) {
    throw new ArchiveWorkerProtocolError(
      "Workspace archive files must contain only path and content strings.",
    );
  }
  return files.map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

function isWorkspaceFileArray(value: unknown): value is ArchiveWorkspaceFile[] {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        isRecord(file) &&
        hasExactKeys(file, ["path", "content"]) &&
        typeof file.path === "string" &&
        typeof file.content === "string",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function invalidMessage(kind: "request" | "response"): ArchiveWorkerProtocolError {
  return new ArchiveWorkerProtocolError(
    `Invalid workspace archive worker ${kind}.`,
  );
}
