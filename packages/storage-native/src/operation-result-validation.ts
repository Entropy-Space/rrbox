import {
  normalizeFilePath,
  normalizePath,
  type WorkspaceChangeMetadata,
  type WorkspaceChangeRecord,
} from "@researchbox/vfs";
import type {
  NativeStorageOperation,
  NativeStorageSuccessResult,
} from "./wire-types.ts";

/**
 * Verifies fields that are valid in isolation but must also belong to the
 * correlated request. Structural response validation runs before this check.
 */
export function validateNativeStorageResultForOperation(
  operation: NativeStorageOperation,
  result: NativeStorageSuccessResult,
): void {
  switch (operation.kind) {
    case "workspace_create":
    case "workspace_open":
      if (
        result.kind === "workspace_opened" &&
        result.workspace.project_id !== operation.project_id
      ) {
        throw new Error(
          "Native storage returned a workspace for another project.",
        );
      }
      return;
    case "workspace_get_path_state":
      if (
        result.kind === "workspace_path_state" &&
        result.value.path !== normalizePath(operation.path)
      ) {
        throw new Error(
          "Native storage returned state for another workspace path.",
        );
      }
      return;
    case "workspace_write":
      if (result.kind === "workspace_written") {
        validateWriteResult(operation, result);
      }
      return;
    case "workspace_remove":
      if (result.kind === "workspace_removed") {
        validateRemoveResult(operation, result);
      }
      return;
    case "workspace_get_change":
      if (
        result.kind === "workspace_change" &&
        result.value.change !== null &&
        result.value.change.change_id !== operation.change_id
      ) {
        throw new Error(
          "Native storage returned a different workspace change than requested.",
        );
      }
      return;
    case "workspace_revert_change":
      if (
        result.kind === "workspace_change_reverted" &&
        result.value.change.change_id !== operation.change_id
      ) {
        throw new Error(
          "Native storage reverted a different workspace change than requested.",
        );
      }
      return;
    default:
      return;
  }
}

function validateWriteResult(
  operation: Extract<
    NativeStorageOperation,
    { kind: "workspace_write" }
  >,
  result: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_written" }
  >,
): void {
  const write = result.value.result;
  if (write.path !== normalizeFilePath(operation.path)) {
    throw new Error(
      "Native storage returned a write for another workspace path.",
    );
  }
  if (write.after_content !== operation.content) {
    throw new Error(
      "Native storage returned a write with different content.",
    );
  }

  const expectedChange = operation.options?.change;
  if (write.change_kind === "unchanged") return;
  if (expectedChange === undefined && write.change !== null) {
    throw new Error(
      "Native storage returned an unexpected write receipt.",
    );
  }
  if (expectedChange !== undefined && write.change === null) {
    throw new Error("Native storage omitted the requested write receipt.");
  }
  if (expectedChange !== undefined && write.change !== null) {
    validateReceiptMetadata(write.change, expectedChange);
  }
}

function validateRemoveResult(
  operation: Extract<
    NativeStorageOperation,
    { kind: "workspace_remove" }
  >,
  result: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_removed" }
  >,
): void {
  const expectedChange = operation.options?.change;
  const remove = result.value.result;
  if (expectedChange === undefined) {
    if (remove !== undefined) {
      throw new Error(
        "Native storage returned an unexpected removal receipt.",
      );
    }
    return;
  }
  if (remove === undefined) {
    throw new Error(
      "Native storage omitted the requested removal receipt.",
    );
  }
  if (remove.path !== normalizeFilePath(operation.path)) {
    throw new Error(
      "Native storage returned a removal for another workspace path.",
    );
  }
  validateReceiptMetadata(remove.change, expectedChange);
}

function validateReceiptMetadata(
  receipt: WorkspaceChangeRecord,
  expected: WorkspaceChangeMetadata,
): void {
  if (
    receipt.change_id !== expected.change_id ||
    receipt.session_id !== expected.session_id ||
    receipt.tool_call_block_id !== expected.tool_call_block_id ||
    receipt.assistant_message_index !==
      expected.assistant_message_index ||
    receipt.tool_call_id !== expected.tool_call_id ||
    receipt.tool_name !== expected.tool_name ||
    receipt.legacy_message_id !== undefined
  ) {
    throw new Error(
      "Native storage receipt does not match the requested change metadata.",
    );
  }
}
