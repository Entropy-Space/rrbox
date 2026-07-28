import {
  assertValidWorkspaceChangeRecord,
  type WorkspaceChangeRecord,
} from "@researchbox/vfs";
import {
  requireAllowedFields,
  requireArray,
  requireEnum,
  requireExactValue,
  requireNonNegativeSafeInteger,
  requireNull,
  requireNullableNonNegativeSafeInteger,
  requireNullableString,
  requireRecord,
  requireString,
} from "./validation.ts";

export function validateWorkspaceListResult(value: unknown): void {
  const result = requireRecord(value, "result.value");
  requireAllowedFields(
    result,
    ["workspace_revision", "entries"],
    "Workspace list result",
  );
  requireWorkspaceRevision(result);
  for (const entry of requireArray(result.entries, "result.value.entries")) {
    const record = requireRecord(entry, "workspace entry");
    requireAllowedFields(
      record,
      ["name", "path", "kind", "size"],
      "Workspace entry",
    );
    requireString(record.name, "workspace entry.name");
    requireString(record.path, "workspace entry.path");
    requireEnum(
      record.kind,
      ["file", "directory"],
      "workspace entry.kind",
    );
    requireNonNegativeSafeInteger(record.size, "workspace entry.size");
  }
}

export function validateWorkspaceReadResult(value: unknown): void {
  const result = requireRecord(value, "result.value");
  requireAllowedFields(
    result,
    ["workspace_revision", "path_revision", "content"],
    "Workspace read result",
  );
  requireWorkspaceRevision(result);
  requireNonNegativeSafeInteger(
    result.path_revision,
    "result.value.path_revision",
  );
  requireString(result.content, "result.value.content");
}

export function validateWorkspacePathStateResult(value: unknown): void {
  const result = requireRecord(value, "result.value");
  const kind = requireEnum(
    result.kind,
    ["file", "directory", "missing"],
    "result.value.kind",
  );
  requireAllowedFields(
    result,
    kind === "file"
      ? [
          "workspace_revision",
          "path",
          "kind",
          "path_revision",
          "content",
        ]
      : ["workspace_revision", "path", "kind", "path_revision"],
    "Workspace path-state result",
  );
  requireWorkspaceRevision(result);
  requireString(result.path, "result.value.path");
  if (kind === "file") {
    requireNonNegativeSafeInteger(
      result.path_revision,
      "result.value.path_revision",
    );
    requireString(result.content, "result.value.content");
    return;
  }
  if (kind === "directory") {
    requireNull(result.path_revision, "result.value.path_revision");
    return;
  }
  requireNullableNonNegativeSafeInteger(
    result.path_revision,
    "result.value.path_revision",
  );
}

export function validateWorkspaceFilesSnapshotResult(
  value: unknown,
): void {
  const result = requireRecord(value, "result.value");
  requireAllowedFields(
    result,
    ["workspace_revision", "files"],
    "Workspace files snapshot",
  );
  requireWorkspaceRevision(result);
  for (const file of requireArray(result.files, "result.value.files")) {
    const record = requireRecord(file, "workspace snapshot file");
    requireAllowedFields(
      record,
      ["path", "content"],
      "Workspace snapshot file",
    );
    requireString(record.path, "workspace snapshot file.path");
    requireString(record.content, "workspace snapshot file.content");
  }
}

export function validateWorkspaceWriteResult(value: unknown): void {
  const result = requireRecord(value, "result.value");
  requireAllowedFields(
    result,
    ["workspace_revision", "result"],
    "Workspace write result",
  );
  const workspaceRevision = requireWorkspaceRevision(result);
  const write = requireRecord(result.result, "result.value.result");
  requireAllowedFields(
    write,
    [
      "path",
      "change_kind",
      "before_content",
      "after_content",
      "change",
    ],
    "Workspace write mutation result",
  );
  const path = requireString(write.path, "write result.path");
  const changeKind = requireEnum(
    write.change_kind,
    ["created", "updated", "unchanged"],
    "write result.change_kind",
  );
  const beforeContent = requireNullableString(
    write.before_content,
    "write result.before_content",
  );
  const afterContent = requireString(
    write.after_content,
    "write result.after_content",
  );
  if (
    (changeKind === "created" && beforeContent !== null) ||
    (changeKind === "updated" &&
      (beforeContent === null || beforeContent === afterContent)) ||
    (changeKind === "unchanged" &&
      (beforeContent === null || beforeContent !== afterContent))
  ) {
    throw new Error("Workspace write result has inconsistent content.");
  }
  if (write.change === null) return;
  if (changeKind === "unchanged") {
    throw new Error("An unchanged workspace write cannot have a receipt.");
  }
  validateWireWorkspaceChangeRecord(write.change, workspaceRevision);
  if (
    write.change.path !== path ||
    write.change.change_kind !== changeKind ||
    write.change.before_content !== beforeContent ||
    write.change.after_content !== afterContent ||
    write.change.applied_workspace_revision !== workspaceRevision ||
    write.change.reverted_at_workspace_revision !== null
  ) {
    throw new Error(
      "Workspace write receipt does not match its mutation result.",
    );
  }
}

export function validateWorkspaceRemoveResult(value: unknown): void {
  const result = requireRecord(value, "result.value");
  requireAllowedFields(
    result,
    ["workspace_revision", "result"],
    "Workspace removal result",
  );
  const workspaceRevision = requireWorkspaceRevision(result);
  if (result.result === undefined) return;
  const remove = requireRecord(result.result, "result.value.result");
  requireAllowedFields(
    remove,
    [
      "path",
      "change_kind",
      "before_content",
      "after_content",
      "change",
    ],
    "Workspace removal mutation result",
  );
  const path = requireString(remove.path, "remove result.path");
  requireExactValue(
    remove.change_kind,
    "deleted",
    "remove result.change_kind",
  );
  const beforeContent = requireString(
    remove.before_content,
    "remove result.before_content",
  );
  requireNull(remove.after_content, "remove result.after_content");
  validateWireWorkspaceChangeRecord(remove.change, workspaceRevision);
  if (
    remove.change.path !== path ||
    remove.change.change_kind !== "deleted" ||
    remove.change.before_content !== beforeContent ||
    remove.change.after_content !== null ||
    remove.change.applied_workspace_revision !== workspaceRevision ||
    remove.change.reverted_at_workspace_revision !== null
  ) {
    throw new Error(
      "Workspace remove receipt does not match its mutation result.",
    );
  }
}

export function validateWorkspaceChangesResult(value: unknown): void {
  const result = requireRecord(value, "result.value");
  requireAllowedFields(
    result,
    ["workspace_revision", "changes", "quarantine_status"],
    "Workspace changes result",
  );
  const workspaceRevision = requireWorkspaceRevision(result);
  for (const change of requireArray(
    result.changes,
    "result.value.changes",
  )) {
    validateWireWorkspaceChangeRecord(change, workspaceRevision);
  }
  if (result.quarantine_status === undefined) return;
  const quarantine = requireRecord(
    result.quarantine_status,
    "result.value.quarantine_status",
  );
  requireAllowedFields(
    quarantine,
    ["quarantined_receipt_count", "pending_receipt_count"],
    "Workspace receipt quarantine status",
  );
  requireNonNegativeSafeInteger(
    quarantine.quarantined_receipt_count,
    "quarantine_status.quarantined_receipt_count",
  );
  requireNonNegativeSafeInteger(
    quarantine.pending_receipt_count,
    "quarantine_status.pending_receipt_count",
  );
}

export function validateWorkspaceChangeResult(value: unknown): void {
  const result = requireRecord(value, "result.value");
  requireAllowedFields(
    result,
    ["workspace_revision", "change"],
    "Workspace change result",
  );
  const workspaceRevision = requireWorkspaceRevision(result);
  if (result.change !== null) {
    validateWireWorkspaceChangeRecord(
      result.change,
      workspaceRevision,
    );
  }
}

export function validateWorkspaceChangeRevertResult(
  value: unknown,
): void {
  const result = requireRecord(value, "result.value");
  requireAllowedFields(
    result,
    [
      "workspace_revision",
      "revert_outcome",
      "reverted_at_workspace_revision",
      "change",
    ],
    "Workspace change revert result",
  );
  const workspaceRevision = requireWorkspaceRevision(result);
  const revertOutcome = requireEnum(
    result.revert_outcome,
    ["applied", "already_reverted"],
    "result.value.revert_outcome",
  );
  const revertedAtWorkspaceRevision =
    requireNonNegativeSafeInteger(
      result.reverted_at_workspace_revision,
      "result.value.reverted_at_workspace_revision",
    );
  validateWireWorkspaceChangeRecord(
    result.change,
    workspaceRevision,
  );
  if (
    result.change.reverted_at_workspace_revision !==
    revertedAtWorkspaceRevision
  ) {
    throw new Error(
      "Workspace revert receipt does not match its revert result.",
    );
  }
  if (
    revertOutcome === "applied" &&
    revertedAtWorkspaceRevision !== workspaceRevision
  ) {
    throw new Error(
      "Applied workspace revert did not commit at the current revision.",
    );
  }
}

function validateWireWorkspaceChangeRecord(
  value: unknown,
  workspaceRevision: number,
): asserts value is WorkspaceChangeRecord {
  const record = requireRecord(value, "workspace change receipt");
  requireAllowedFields(
    record,
    [
      "change_id",
      "session_id",
      "tool_call_block_id",
      "legacy_message_id",
      "assistant_message_index",
      "tool_call_id",
      "tool_name",
      "created_at",
      "applied_workspace_revision",
      "reverted_at_workspace_revision",
      "path",
      "change_kind",
      "before_content",
      "after_content",
      "additions",
      "deletions",
      "byte_size",
    ],
    "Workspace change receipt",
  );
  assertValidWorkspaceChangeRecord(record, workspaceRevision);
}

function requireWorkspaceRevision(
  value: Record<string, unknown>,
): number {
  return requireNonNegativeSafeInteger(
    value.workspace_revision,
    "result.value.workspace_revision",
  );
}
