import {
  assertValidWorkspaceChangeRecord,
  WorkspaceCorruptionError,
  type WorkspaceChangeRecord,
} from "@researchbox/vfs";

export type WorkspaceChangeStorageRecord = Omit<
  WorkspaceChangeRecord,
  | "tool_call_block_id"
  | "legacy_message_id"
  | "applied_workspace_revision"
  | "reverted_at_workspace_revision"
> & {
  project_id: string;
  tool_call_block_id?: string | null;
  message_id?: string;
  applied_workspace_revision?: unknown;
  reverted_at_workspace_revision?: unknown;
};

type StoredWorkspaceChangeExpectation = {
  project_id: string;
  change_id: string;
  incarnation_baseline_revision: number;
  workspace_revision: number;
};

export function assertValidStoredWorkspaceChangeRecord(
  record: WorkspaceChangeStorageRecord,
  expected: StoredWorkspaceChangeExpectation,
): WorkspaceChangeRecord {
  if (
    record.project_id !== expected.project_id ||
    record.change_id !== expected.change_id
  ) {
    throw invalidStoredWorkspaceChangeRecord(
      "does not match its storage identity",
    );
  }
  if (
    record.tool_call_block_id !== undefined &&
    record.tool_call_block_id !== null &&
    (typeof record.tool_call_block_id !== "string" ||
      record.tool_call_block_id.length === 0)
  ) {
    throw invalidStoredWorkspaceChangeRecord(
      "has an invalid tool_call_block_id",
    );
  }
  if (
    record.message_id !== undefined &&
    (typeof record.message_id !== "string" ||
      record.message_id.length === 0)
  ) {
    throw invalidStoredWorkspaceChangeRecord(
      "has an invalid legacy message_id",
    );
  }
  assertStoredNullableWorkspaceRevision(
    record.applied_workspace_revision,
    "applied_workspace_revision",
  );
  assertStoredNullableWorkspaceRevision(
    record.reverted_at_workspace_revision,
    "reverted_at_workspace_revision",
  );

  const change = toWorkspaceChangeRecord(record);
  assertValidWorkspaceChangeRecord(
    change,
    expected.workspace_revision,
  );
  if (
    change.applied_workspace_revision !== null &&
    change.applied_workspace_revision <=
      expected.incarnation_baseline_revision
  ) {
    throw invalidStoredWorkspaceChangeRecord(
      "was not applied in the current workspace incarnation",
    );
  }
  return change;
}

function toWorkspaceChangeRecord(
  record: WorkspaceChangeStorageRecord,
): WorkspaceChangeRecord {
  const toolCallBlockId =
    typeof record.tool_call_block_id === "string" &&
    record.tool_call_block_id.length > 0
      ? record.tool_call_block_id
      : null;
  const legacyMessageId =
    toolCallBlockId === null &&
    typeof record.message_id === "string" &&
    record.message_id.length > 0
      ? record.message_id
      : undefined;
  return {
    change_id: record.change_id,
    session_id: record.session_id,
    tool_call_block_id: toolCallBlockId,
    ...(legacyMessageId === undefined
      ? {}
      : { legacy_message_id: legacyMessageId }),
    assistant_message_index: record.assistant_message_index,
    tool_call_id: record.tool_call_id,
    tool_name: record.tool_name,
    created_at: record.created_at,
    applied_workspace_revision: normalizeOptionalStoredRevision(
      record.applied_workspace_revision,
    ),
    reverted_at_workspace_revision: normalizeOptionalStoredRevision(
      record.reverted_at_workspace_revision,
    ),
    path: record.path,
    change_kind: record.change_kind,
    before_content: record.before_content,
    after_content: record.after_content,
    additions: record.additions,
    deletions: record.deletions,
    byte_size: record.byte_size,
  };
}

export function assertValidStoredPathRevision(
  value: unknown,
  workspaceRevision: number,
  path: string,
): number {
  if (value === undefined) return 0;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > workspaceRevision
  ) {
    throw new WorkspaceCorruptionError(
      `Persisted workspace path revision is invalid: ${path}`,
    );
  }
  return value as number;
}

function assertStoredNullableWorkspaceRevision(
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidStoredWorkspaceChangeRecord(
      `has an invalid ${field}`,
    );
  }
}

function normalizeOptionalStoredRevision(
  value: unknown,
): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function invalidStoredWorkspaceChangeRecord(
  detail: string,
): WorkspaceCorruptionError {
  return new WorkspaceCorruptionError(
    `Persisted workspace change receipt ${detail}.`,
  );
}
