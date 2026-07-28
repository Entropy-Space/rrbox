import {
  parseProjectStoreStateWithMigration,
} from "@researchbox/project-store";
import type { WorkspaceChangeMetadata } from "@researchbox/vfs";
import {
  NATIVE_STORAGE_PROTOCOL_VERSION,
  nativeStorageResultKindByOperation,
  type NativeStorageRequest,
} from "./wire-types.ts";
import {
  hasOwnField,
  requireAllowedFields,
  requireArray,
  requireEnum,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requireNullableNonNegativeSafeInteger,
  requireNullableString,
  requireRecord,
  requireString,
  validateWorkspaceHandle,
} from "./validation.ts";

const operationKinds = new Set<string>(
  Object.keys(nativeStorageResultKindByOperation),
);

export function parseNativeStorageRequest(
  value: unknown,
): NativeStorageRequest {
  const record = requireRecord(value, "Native storage request");
  requireAllowedFields(
    record,
    ["protocol_version", "request_id", "operation"],
    "Native storage request",
  );
  if (record.protocol_version !== NATIVE_STORAGE_PROTOCOL_VERSION) {
    throw new Error("Unsupported native storage protocol version.");
  }
  requireNonEmptyString(record.request_id, "request_id");
  const operation = requireRecord(
    record.operation,
    "Native storage operation",
  );
  const kind = requireNonEmptyString(operation.kind, "operation.kind");
  if (!operationKinds.has(kind)) {
    throw new Error(`Unsupported native storage operation: ${kind}`);
  }
  validateNativeStorageOperation(operation, kind);
  return value as NativeStorageRequest;
}

function validateNativeStorageOperation(
  operation: Record<string, unknown>,
  kind: string,
): void {
  switch (kind) {
    case "health":
    case "initialize":
    case "project_store_load":
      requireAllowedFields(operation, ["kind"], `Operation ${kind}`);
      return;
    case "project_store_save":
      validateProjectStoreSave(operation, kind);
      return;
    case "project_usage":
    case "workspace_open":
    case "workspace_delete":
      requireAllowedFields(
        operation,
        ["kind", "project_id"],
        `Operation ${kind}`,
      );
      requireNonEmptyString(
        operation.project_id,
        "operation.project_id",
      );
      return;
    case "workspace_create":
      validateWorkspaceCreate(operation, kind);
      return;
    case "workspace_reconcile_orphans":
      requireAllowedFields(
        operation,
        ["kind", "retained_project_ids"],
        `Operation ${kind}`,
      );
      for (const projectId of requireArray(
        operation.retained_project_ids,
        "operation.retained_project_ids",
      )) {
        requireNonEmptyString(
          projectId,
          "operation.retained_project_ids[]",
        );
      }
      return;
    case "workspace_list":
    case "workspace_read":
    case "workspace_get_path_state":
      requireAllowedFields(
        operation,
        ["kind", "workspace", "path"],
        `Operation ${kind}`,
      );
      validateWorkspaceHandle(operation.workspace, "operation.workspace");
      requireString(operation.path, "operation.path");
      return;
    case "workspace_read_files_snapshot":
    case "workspace_list_changes":
      requireAllowedFields(
        operation,
        ["kind", "workspace"],
        `Operation ${kind}`,
      );
      validateWorkspaceHandle(operation.workspace, "operation.workspace");
      return;
    case "workspace_write":
      validateWorkspaceWrite(operation, kind);
      return;
    case "workspace_remove":
      validateWorkspaceRemove(operation, kind);
      return;
    case "workspace_get_change":
    case "workspace_revert_change":
      requireAllowedFields(
        operation,
        ["kind", "workspace", "change_id"],
        `Operation ${kind}`,
      );
      validateWorkspaceHandle(operation.workspace, "operation.workspace");
      requireNonEmptyString(
        operation.change_id,
        "operation.change_id",
      );
      return;
  }
}

function validateProjectStoreSave(
  operation: Record<string, unknown>,
  kind: string,
): void {
  requireAllowedFields(
    operation,
    ["kind", "state", "expected_revision"],
    `Operation ${kind}`,
  );
  const parsedState = parseProjectStoreStateWithMigration(
    operation.state,
  );
  if (parsedState.was_migrated) {
    throw new Error(
      "Native project-store saves require the current schema.",
    );
  }
  const expectedRevision =
    requireNullableNonNegativeSafeInteger(
      operation.expected_revision,
      "operation.expected_revision",
    );
  requireNonNegativeSafeInteger(
    parsedState.state.state_revision,
    "operation.state.state_revision",
  );
  if (
    parsedState.state.state_revision !==
    (expectedRevision ?? 0) + 1
  ) {
    throw new Error(
      "Project store revisions must increase by exactly one.",
    );
  }
}

function validateWorkspaceCreate(
  operation: Record<string, unknown>,
  kind: string,
): void {
  requireAllowedFields(
    operation,
    ["kind", "project_id", "initial_files"],
    `Operation ${kind}`,
  );
  requireNonEmptyString(
    operation.project_id,
    "operation.project_id",
  );
  if (!hasOwnField(operation, "initial_files")) return;

  // Entry validation belongs to the atomic Rust operation so an existing
  // workspace keeps `already_exists` precedence over malformed seed data.
  requireArray(
    operation.initial_files,
    "operation.initial_files",
  );
}

function validateWorkspaceWrite(
  operation: Record<string, unknown>,
  kind: string,
): void {
  requireAllowedFields(
    operation,
    ["kind", "workspace", "path", "content", "options"],
    `Operation ${kind}`,
  );
  validateWorkspaceHandle(operation.workspace, "operation.workspace");
  requireString(operation.path, "operation.path");
  requireString(operation.content, "operation.content");
  if (hasOwnField(operation, "options")) {
    validateWorkspaceWriteOptions(operation.options);
  }
}

function validateWorkspaceRemove(
  operation: Record<string, unknown>,
  kind: string,
): void {
  requireAllowedFields(
    operation,
    ["kind", "workspace", "path", "options"],
    `Operation ${kind}`,
  );
  validateWorkspaceHandle(operation.workspace, "operation.workspace");
  requireString(operation.path, "operation.path");
  if (hasOwnField(operation, "options")) {
    validateWorkspaceRemoveOptions(operation.options);
  }
}

function validateWorkspaceWriteOptions(value: unknown): void {
  const options = requireRecord(value, "Workspace write options");
  requireAllowedFields(
    options,
    ["expected_content", "change"],
    "Workspace write options",
  );
  if (hasOwnField(options, "expected_content")) {
    requireNullableString(
      options.expected_content,
      "options.expected_content",
    );
  }
  if (hasOwnField(options, "change")) {
    validateWorkspaceChangeMetadata(options.change);
  }
}

function validateWorkspaceRemoveOptions(value: unknown): void {
  const options = requireRecord(value, "Workspace remove options");
  requireAllowedFields(
    options,
    ["expected_content", "change"],
    "Workspace remove options",
  );
  if (hasOwnField(options, "expected_content")) {
    requireString(
      options.expected_content,
      "options.expected_content",
    );
  }
  if (hasOwnField(options, "change")) {
    validateWorkspaceChangeMetadata(options.change);
  }
}

function validateWorkspaceChangeMetadata(
  value: unknown,
): asserts value is WorkspaceChangeMetadata {
  const change = requireRecord(value, "Workspace change metadata");
  requireAllowedFields(
    change,
    [
      "change_id",
      "session_id",
      "tool_call_block_id",
      "assistant_message_index",
      "tool_call_id",
      "tool_name",
      "created_at",
    ],
    "Workspace change metadata",
  );
  for (const field of [
    "change_id",
    "session_id",
    "tool_call_block_id",
    "tool_call_id",
  ] as const) {
    requireNonEmptyString(change[field], `change.${field}`);
  }
  requireNonNegativeSafeInteger(
    change.assistant_message_index,
    "change.assistant_message_index",
  );
  requireEnum(
    change.tool_name,
    ["write_file", "replace_text", "remove_file"],
    "change.tool_name",
  );
  requireString(change.created_at, "change.created_at");
}
