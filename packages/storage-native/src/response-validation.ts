import {
  NATIVE_STORAGE_PROTOCOL_VERSION,
  nativeStorageResultKindByOperation,
  type NativeStorageError,
  type NativeStorageErrorCode,
  type NativeStorageResponse,
} from "./wire-types.ts";
import {
  hasOwnField,
  requireAllowedFields,
  requireArray,
  requireBoolean,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requireRecord,
  validateWorkspaceHandle,
} from "./validation.ts";
import {
  validateWorkspaceChangeResult,
  validateWorkspaceChangeRevertResult,
  validateWorkspaceChangesResult,
  validateWorkspaceFilesSnapshotResult,
  validateWorkspaceListResult,
  validateWorkspacePathStateResult,
  validateWorkspaceReadResult,
  validateWorkspaceRemoveResult,
  validateWorkspaceWriteResult,
} from "./workspace-result-validation.ts";

const resultKinds = new Set<string>([
  ...Object.values(nativeStorageResultKindByOperation),
  "error",
]);
const errorCodes = new Set<string>([
  "project_store_conflict",
  "workspace_already_exists",
  "workspace_not_found",
  "vfs_invalid_path",
  "vfs_not_found",
  "vfs_not_directory",
  "vfs_is_directory",
  "vfs_conflict",
  "workspace_corruption",
  "invalid_request",
  "internal",
] satisfies NativeStorageErrorCode[]);

export function parseNativeStorageResponse(
  value: unknown,
): NativeStorageResponse {
  const record = requireRecord(value, "Native storage response");
  requireAllowedFields(
    record,
    ["protocol_version", "request_id", "result"],
    "Native storage response",
  );
  if (record.protocol_version !== NATIVE_STORAGE_PROTOCOL_VERSION) {
    throw new Error("Unsupported native storage protocol version.");
  }
  requireNonEmptyString(record.request_id, "request_id");
  const result = requireRecord(record.result, "Native storage result");
  const kind = requireNonEmptyString(result.kind, "result.kind");
  if (!resultKinds.has(kind)) {
    throw new Error(`Unsupported native storage result: ${kind}`);
  }
  validateNativeStorageResult(result, kind);
  return value as NativeStorageResponse;
}

export function createNativeStorageErrorResponse(
  requestId: string,
  error: NativeStorageError,
): NativeStorageResponse {
  return {
    protocol_version: NATIVE_STORAGE_PROTOCOL_VERSION,
    request_id: requestId,
    result: {
      kind: "error",
      error,
    },
  };
}

function validateNativeStorageResult(
  result: Record<string, unknown>,
  kind: string,
): void {
  switch (kind) {
    case "health":
      requireAllowedFields(
        result,
        ["kind", "initialized"],
        "Native storage health result",
      );
      requireBoolean(result.initialized, "result.initialized");
      return;
    case "initialized":
    case "project_store_saved":
    case "dsh_session_appended":
    case "dsh_session_deleted":
    case "workspace_deleted":
    case "workspace_orphans_reconciled":
      requireAllowedFields(
        result,
        ["kind"],
        `Native storage ${kind} result`,
      );
      return;
    case "project_store_loaded":
      requireAllowedFields(
        result,
        ["kind", "state"],
        "Native project-store load result",
      );
      if (result.state !== null) {
        requireRecord(result.state, "result.state");
      }
      return;
    case "dsh_session_loaded":
      requireValueResultFields(result, kind);
      if (result.value !== null) {
        validateDshStoredSession(result.value, true);
      }
      return;
    case "dsh_session_suffix_loaded":
      requireValueResultFields(result, kind);
      if (result.value !== null) {
        validateDshStoredSession(result.value, false);
      }
      return;
    case "dsh_session_revision":
      requireValueResultFields(result, kind);
      if (result.value !== null) {
        validateDshRevision(result.value, "result.value");
      }
      return;
    case "dsh_sessions_listed":
      requireAllowedFields(
        result,
        ["kind", "headers"],
        "Native DSH session-list result",
      );
      for (const [index, header] of requireArray(
        result.headers,
        "result.headers",
      ).entries()) {
        validateDshHeader(header, `result.headers[${index}]`);
      }
      return;
    case "project_usage":
      requireAllowedFields(
        result,
        ["kind", "value"],
        "Native project-usage result",
      );
      validateProjectUsage(result.value);
      return;
    case "workspace_opened":
      requireAllowedFields(
        result,
        ["kind", "workspace"],
        "Native workspace-open result",
      );
      validateWorkspaceHandle(result.workspace, "result.workspace");
      return;
    case "workspace_listed":
      requireValueResultFields(result, kind);
      validateWorkspaceListResult(result.value);
      return;
    case "workspace_read":
      requireValueResultFields(result, kind);
      validateWorkspaceReadResult(result.value);
      return;
    case "workspace_path_state":
      requireValueResultFields(result, kind);
      validateWorkspacePathStateResult(result.value);
      return;
    case "workspace_files_snapshot":
      requireValueResultFields(result, kind);
      validateWorkspaceFilesSnapshotResult(result.value);
      return;
    case "workspace_written":
      requireValueResultFields(result, kind);
      validateWorkspaceWriteResult(result.value);
      return;
    case "workspace_removed":
      requireValueResultFields(result, kind);
      validateWorkspaceRemoveResult(result.value);
      return;
    case "workspace_changes_listed":
      requireValueResultFields(result, kind);
      validateWorkspaceChangesResult(result.value);
      return;
    case "workspace_change":
      requireValueResultFields(result, kind);
      validateWorkspaceChangeResult(result.value);
      return;
    case "workspace_change_reverted":
      requireValueResultFields(result, kind);
      validateWorkspaceChangeRevertResult(result.value);
      return;
    case "error":
      requireAllowedFields(
        result,
        ["kind", "error"],
        "Native storage error result",
      );
      parseNativeStorageError(result.error);
      return;
  }
}

function validateDshStoredSession(
  value: unknown,
  includeRevision: boolean,
): void {
  const stored = requireRecord(value, "result.value");
  requireAllowedFields(
    stored,
    includeRevision
      ? ["header", "events", "storage_id", "revision"]
      : ["header", "events"],
    "Native DSH stored session",
  );
  validateDshHeader(stored.header, "result.value.header");
  for (const [index, event] of requireArray(
    stored.events,
    "result.value.events",
  ).entries()) {
    validateDshEvent(event, `result.value.events[${index}]`);
  }
  if (includeRevision) {
    validateDshRevision(stored, "result.value");
  }
}

function validateDshRevision(value: unknown, label: string): void {
  const revision = requireRecord(value, label);
  const storageId = requireNonEmptyString(
    revision.storage_id,
    `${label}.storage_id`,
  );
  if (!/^[0-9a-f]{32}$/u.test(storageId)) {
    throw new Error(`${label}.storage_id must be a lowercase UUID hex value.`);
  }
  const revisionNumber = requireNonNegativeSafeInteger(
    revision.revision,
    `${label}.revision`,
  );
  if (revisionNumber === 0) {
    throw new Error(`${label}.revision must be positive.`);
  }
}

function validateDshHeader(value: unknown, label: string): void {
  const header = requireRecord(value, label);
  requireNonEmptyString(header.id, `${label}.id`);
  requireNonNegativeSafeInteger(header.version, `${label}.version`);
  requireNonNegativeSafeInteger(header.createdAt, `${label}.createdAt`);
}

function validateDshEvent(value: unknown, label: string): void {
  const event = requireRecord(value, label);
  requireNonEmptyString(event.type, `${label}.type`);
  requireNonNegativeSafeInteger(event.seq, `${label}.seq`);
  requireNonNegativeSafeInteger(event.time, `${label}.time`);
  if (!hasOwnField(event, "data")) {
    throw new Error(`${label}.data is required.`);
  }
}

function requireValueResultFields(
  result: Record<string, unknown>,
  kind: string,
): void {
  requireAllowedFields(
    result,
    ["kind", "value"],
    `Native storage ${kind} result`,
  );
}

function parseNativeStorageError(value: unknown): NativeStorageError {
  const record = requireRecord(value, "Native storage error");
  requireAllowedFields(
    record,
    ["code", "message"],
    "Native storage error",
  );
  const code = requireNonEmptyString(record.code, "error.code");
  if (!errorCodes.has(code)) {
    throw new Error(`Unsupported native storage error code: ${code}`);
  }
  requireNonEmptyString(record.message, "error.message");
  return value as NativeStorageError;
}

function validateProjectUsage(value: unknown): void {
  const usage = requireRecord(value, "result.value");
  requireAllowedFields(
    usage,
    ["logical_bytes", "database_bytes", "disk_bytes", "breakdown"],
    "Native project usage",
  );
  requireNonNegativeSafeInteger(
    usage.logical_bytes,
    "usage.logical_bytes",
  );
  requireNonNegativeSafeInteger(
    usage.database_bytes,
    "usage.database_bytes",
  );
  requireNonNegativeSafeInteger(usage.disk_bytes, "usage.disk_bytes");
  const breakdown = requireRecord(
    usage.breakdown,
    "usage.breakdown",
  );
  requireAllowedFields(
    breakdown,
    [
      "workspace_bytes",
      "conversation_bytes",
      "history_bytes",
      "database_overhead_bytes",
    ],
    "Native project usage breakdown",
  );
  requireNonNegativeSafeInteger(
    breakdown.workspace_bytes,
    "usage.breakdown.workspace_bytes",
  );
  requireNonNegativeSafeInteger(
    breakdown.conversation_bytes,
    "usage.breakdown.conversation_bytes",
  );
  requireNonNegativeSafeInteger(
    breakdown.history_bytes,
    "usage.breakdown.history_bytes",
  );
  requireNonNegativeSafeInteger(
    breakdown.database_overhead_bytes,
    "usage.breakdown.database_overhead_bytes",
  );
}
