import type { ProjectStoreState } from "@researchbox/project-store";
import type {
  VfsRemoveOptions,
  VfsWriteOptions,
  WorkspaceChangeResult,
  WorkspaceChangeRevertResult,
  WorkspaceChangesResult,
  WorkspaceFilesSnapshotResult,
  WorkspaceListResult,
  WorkspacePathStateResult,
  WorkspaceReadResult,
  WorkspaceRemoveResult,
  WorkspaceWriteResult,
} from "@researchbox/vfs";

export const NATIVE_STORAGE_PROTOCOL_VERSION = 1 as const;

export type NativeWorkspaceHandle = {
  project_id: string;
  incarnation_id: string;
};

export type NativeProjectUsageBreakdown = {
  workspace_bytes: number;
  conversation_bytes: number;
  history_bytes: number;
  database_overhead_bytes: number;
};

export type NativeProjectUsage = {
  logical_bytes: number;
  database_bytes: number;
  disk_bytes: number;
  breakdown: NativeProjectUsageBreakdown;
};

export type NativeDshSessionRevision = {
  storage_id: string;
  revision: number;
};

export type NativeDshStoredSession = NativeDshSessionRevision & {
  header: unknown;
  events: readonly unknown[];
};

export type NativeDshStoredSessionSuffix = {
  header: unknown;
  events: readonly unknown[];
};

export type NativeStorageOperation =
  | {
      kind: "health";
    }
  | {
      kind: "initialize";
    }
  | {
      kind: "project_store_load";
    }
  | {
      kind: "project_store_save";
      state: ProjectStoreState;
      expected_revision: number | null;
    }
  | {
      kind: "project_usage";
      project_id: string;
    }
  | {
      kind: "dsh_session_load";
      project_id: string;
      session_id: string;
    }
  | {
      kind: "dsh_session_load_from";
      project_id: string;
      session_id: string;
      from_seq: number;
    }
  | {
      kind: "dsh_session_read_revision";
      project_id: string;
      session_id: string;
    }
  | {
      kind: "dsh_session_append";
      project_id: string;
      header: unknown;
      events: readonly unknown[];
      is_materialized: boolean;
    }
  | {
      kind: "dsh_session_list";
      project_id: string;
    }
  | {
      kind: "dsh_session_delete";
      project_id: string;
      session_id: string;
    }
  | {
      kind: "workspace_create";
      project_id: string;
      /**
       * Raw JSON entries validated by the atomic native create operation after
       * it checks whether the workspace already exists.
       */
      initial_files?: readonly unknown[];
    }
  | {
      kind: "workspace_open";
      project_id: string;
    }
  | {
      kind: "workspace_delete";
      project_id: string;
    }
  | {
      kind: "workspace_reconcile_orphans";
      retained_project_ids: readonly string[];
    }
  | {
      kind: "workspace_list";
      workspace: NativeWorkspaceHandle;
      path: string;
    }
  | {
      kind: "workspace_read";
      workspace: NativeWorkspaceHandle;
      path: string;
    }
  | {
      kind: "workspace_get_path_state";
      workspace: NativeWorkspaceHandle;
      path: string;
    }
  | {
      kind: "workspace_read_files_snapshot";
      workspace: NativeWorkspaceHandle;
    }
  | {
      kind: "workspace_write";
      workspace: NativeWorkspaceHandle;
      path: string;
      content: string;
      options?: VfsWriteOptions;
    }
  | {
      kind: "workspace_remove";
      workspace: NativeWorkspaceHandle;
      path: string;
      options?: VfsRemoveOptions;
    }
  | {
      kind: "workspace_list_changes";
      workspace: NativeWorkspaceHandle;
    }
  | {
      kind: "workspace_get_change";
      workspace: NativeWorkspaceHandle;
      change_id: string;
    }
  | {
      kind: "workspace_revert_change";
      workspace: NativeWorkspaceHandle;
      change_id: string;
    };

export type NativeStorageRequest = {
  protocol_version: typeof NATIVE_STORAGE_PROTOCOL_VERSION;
  request_id: string;
  operation: NativeStorageOperation;
};

export type NativeStorageErrorCode =
  | "project_store_conflict"
  | "workspace_already_exists"
  | "workspace_not_found"
  | "vfs_invalid_path"
  | "vfs_not_found"
  | "vfs_not_directory"
  | "vfs_is_directory"
  | "vfs_conflict"
  | "workspace_corruption"
  | "invalid_request"
  | "internal";

export type NativeStorageError = {
  code: NativeStorageErrorCode;
  message: string;
};

export type NativeStorageSuccessResult =
  | {
      kind: "health";
      initialized: boolean;
    }
  | {
      kind: "initialized";
    }
  | {
      kind: "project_store_loaded";
      state: ProjectStoreState | null;
    }
  | {
      kind: "project_store_saved";
    }
  | {
      kind: "project_usage";
      value: NativeProjectUsage;
    }
  | {
      kind: "dsh_session_loaded";
      value: NativeDshStoredSession | null;
    }
  | {
      kind: "dsh_session_suffix_loaded";
      value: NativeDshStoredSessionSuffix | null;
    }
  | {
      kind: "dsh_session_revision";
      value: NativeDshSessionRevision | null;
    }
  | {
      kind: "dsh_session_appended";
    }
  | {
      kind: "dsh_sessions_listed";
      headers: readonly unknown[];
    }
  | {
      kind: "dsh_session_deleted";
    }
  | {
      kind: "workspace_opened";
      workspace: NativeWorkspaceHandle;
    }
  | {
      kind: "workspace_deleted";
    }
  | {
      kind: "workspace_orphans_reconciled";
    }
  | {
      kind: "workspace_listed";
      value: WorkspaceListResult;
    }
  | {
      kind: "workspace_read";
      value: WorkspaceReadResult;
    }
  | {
      kind: "workspace_path_state";
      value: WorkspacePathStateResult;
    }
  | {
      kind: "workspace_files_snapshot";
      value: WorkspaceFilesSnapshotResult;
    }
  | {
      kind: "workspace_written";
      value: WorkspaceWriteResult;
    }
  | {
      kind: "workspace_removed";
      value: WorkspaceRemoveResult;
    }
  | {
      kind: "workspace_changes_listed";
      value: WorkspaceChangesResult;
    }
  | {
      kind: "workspace_change";
      value: WorkspaceChangeResult;
    }
  | {
      kind: "workspace_change_reverted";
      value: WorkspaceChangeRevertResult;
    };

export type NativeStorageErrorResult = {
  kind: "error";
  error: NativeStorageError;
};

export type NativeStorageResult =
  | NativeStorageSuccessResult
  | NativeStorageErrorResult;

export type NativeStorageResponse = {
  protocol_version: typeof NATIVE_STORAGE_PROTOCOL_VERSION;
  request_id: string;
  result: NativeStorageResult;
};

export interface NativeStorageOperationResultMap {
  health: Extract<NativeStorageSuccessResult, { kind: "health" }>;
  initialize: Extract<
    NativeStorageSuccessResult,
    { kind: "initialized" }
  >;
  project_store_load: Extract<
    NativeStorageSuccessResult,
    { kind: "project_store_loaded" }
  >;
  project_store_save: Extract<
    NativeStorageSuccessResult,
    { kind: "project_store_saved" }
  >;
  project_usage: Extract<
    NativeStorageSuccessResult,
    { kind: "project_usage" }
  >;
  dsh_session_load: Extract<
    NativeStorageSuccessResult,
    { kind: "dsh_session_loaded" }
  >;
  dsh_session_load_from: Extract<
    NativeStorageSuccessResult,
    { kind: "dsh_session_suffix_loaded" }
  >;
  dsh_session_read_revision: Extract<
    NativeStorageSuccessResult,
    { kind: "dsh_session_revision" }
  >;
  dsh_session_append: Extract<
    NativeStorageSuccessResult,
    { kind: "dsh_session_appended" }
  >;
  dsh_session_list: Extract<
    NativeStorageSuccessResult,
    { kind: "dsh_sessions_listed" }
  >;
  dsh_session_delete: Extract<
    NativeStorageSuccessResult,
    { kind: "dsh_session_deleted" }
  >;
  workspace_create: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_opened" }
  >;
  workspace_open: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_opened" }
  >;
  workspace_delete: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_deleted" }
  >;
  workspace_reconcile_orphans: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_orphans_reconciled" }
  >;
  workspace_list: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_listed" }
  >;
  workspace_read: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_read" }
  >;
  workspace_get_path_state: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_path_state" }
  >;
  workspace_read_files_snapshot: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_files_snapshot" }
  >;
  workspace_write: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_written" }
  >;
  workspace_remove: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_removed" }
  >;
  workspace_list_changes: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_changes_listed" }
  >;
  workspace_get_change: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_change" }
  >;
  workspace_revert_change: Extract<
    NativeStorageSuccessResult,
    { kind: "workspace_change_reverted" }
  >;
}

export type NativeStorageResultFor<
  TOperation extends NativeStorageOperation,
> = NativeStorageOperationResultMap[TOperation["kind"]];

export const nativeStorageResultKindByOperation = {
  health: "health",
  initialize: "initialized",
  project_store_load: "project_store_loaded",
  project_store_save: "project_store_saved",
  project_usage: "project_usage",
  dsh_session_load: "dsh_session_loaded",
  dsh_session_load_from: "dsh_session_suffix_loaded",
  dsh_session_read_revision: "dsh_session_revision",
  dsh_session_append: "dsh_session_appended",
  dsh_session_list: "dsh_sessions_listed",
  dsh_session_delete: "dsh_session_deleted",
  workspace_create: "workspace_opened",
  workspace_open: "workspace_opened",
  workspace_delete: "workspace_deleted",
  workspace_reconcile_orphans: "workspace_orphans_reconciled",
  workspace_list: "workspace_listed",
  workspace_read: "workspace_read",
  workspace_get_path_state: "workspace_path_state",
  workspace_read_files_snapshot: "workspace_files_snapshot",
  workspace_write: "workspace_written",
  workspace_remove: "workspace_removed",
  workspace_list_changes: "workspace_changes_listed",
  workspace_get_change: "workspace_change",
  workspace_revert_change: "workspace_change_reverted",
} as const satisfies {
  [TKind in NativeStorageOperation["kind"]]:
    NativeStorageOperationResultMap[TKind]["kind"];
};
