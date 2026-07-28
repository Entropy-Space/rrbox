import {
  normalizeVfsInitialFiles,
  normalizeVfsSeedFiles,
  snapshotWorkspaceCreateOptions,
  type VfsRemoveOptions,
  type VfsSeedFile,
  type VfsSeedSource,
  type VfsWriteOptions,
  type Workspace,
  type WorkspaceBackend,
  type WorkspaceCreateOptions,
  type WorkspaceFilesSnapshotOptions,
  type WorkspaceFilesSnapshotReader,
  type WorkspaceOrphanReconciler,
} from "@researchbox/vfs";
import type { NativeWorkspaceHandle } from "./protocol.ts";
import { NativeStorageRpcClient } from "./rpc-client.ts";

export class NativeWorkspaceBackend
  implements WorkspaceBackend, WorkspaceOrphanReconciler
{
  private readonly client: NativeStorageRpcClient;
  private readonly defaultInitialFiles:
    | readonly Readonly<VfsSeedFile>[]
    | undefined;

  constructor(
    client: NativeStorageRpcClient,
    options: NativeWorkspaceBackendOptions = {},
  ) {
    this.client = client;
    this.defaultInitialFiles =
      options.default_initial_files === undefined
        ? undefined
        : isVfsSeedFileArray(options.default_initial_files)
          ? normalizeVfsInitialFiles(options.default_initial_files)
          : normalizeVfsSeedFiles(options.default_initial_files);
  }

  async create(
    projectId: string,
    options?: WorkspaceCreateOptions,
  ): Promise<Workspace> {
    const createOptions = snapshotWorkspaceCreateOptions(options);
    const initialFiles =
      createOptions?.initial_files ?? this.defaultInitialFiles;
    await this.client.ensureInitialized();
    const result = await this.client.request({
      kind: "workspace_create",
      project_id: projectId,
      ...(initialFiles === undefined
        ? {}
        : {
            initial_files: encodeNativeInitialFiles(initialFiles),
          }),
    });
    return this.createWorkspace(
      requireWorkspaceHandle(result.workspace, projectId),
    );
  }

  async open(projectId: string): Promise<Workspace> {
    await this.client.ensureInitialized();
    const result = await this.client.request({
      kind: "workspace_open",
      project_id: projectId,
    });
    return this.createWorkspace(
      requireWorkspaceHandle(result.workspace, projectId),
    );
  }

  async delete(projectId: string): Promise<void> {
    await this.client.ensureInitialized();
    await this.client.request({
      kind: "workspace_delete",
      project_id: projectId,
    });
  }

  async reconcileOrphanedWorkspaces(
    retainedProjectIds: readonly string[],
  ): Promise<void> {
    const retained = [...retainedProjectIds];
    await this.client.ensureInitialized();
    await this.client.request({
      kind: "workspace_reconcile_orphans",
      retained_project_ids: retained,
    });
  }

  private createWorkspace(
    handle: NativeWorkspaceHandle,
  ): Workspace & WorkspaceFilesSnapshotReader {
    const workspace = structuredClone(handle);
    return {
      list: async (path) => {
        await this.client.ensureInitialized();
        const result = await this.client.request({
          kind: "workspace_list",
          workspace,
          path,
        });
        return structuredClone(result.value);
      },
      read: async (path) => {
        await this.client.ensureInitialized();
        const result = await this.client.request({
          kind: "workspace_read",
          workspace,
          path,
        });
        return structuredClone(result.value);
      },
      getPathState: async (path) => {
        await this.client.ensureInitialized();
        const result = await this.client.request({
          kind: "workspace_get_path_state",
          workspace,
          path,
        });
        return structuredClone(result.value);
      },
      readFilesSnapshot: async (
        options?: WorkspaceFilesSnapshotOptions,
      ) => {
        if (options?.signal?.aborted) throw createAbortError();
        await this.client.ensureInitialized();
        const result = await this.client.request(
          {
            kind: "workspace_read_files_snapshot",
            workspace,
          },
          { signal: options?.signal },
        );
        return structuredClone(result.value);
      },
      write: async (
        path: string,
        content: string,
        options?: VfsWriteOptions,
      ) => {
        const optionsSnapshot =
          options === undefined
            ? undefined
            : structuredClone(options);
        await this.client.ensureInitialized();
        const result = await this.client.request({
          kind: "workspace_write",
          workspace,
          path,
          content,
          ...(optionsSnapshot === undefined
            ? {}
            : { options: optionsSnapshot }),
        });
        return structuredClone(result.value);
      },
      remove: async (
        path: string,
        options?: VfsRemoveOptions,
      ) => {
        const optionsSnapshot =
          options === undefined
            ? undefined
            : structuredClone(options);
        await this.client.ensureInitialized();
        const result = await this.client.request({
          kind: "workspace_remove",
          workspace,
          path,
          ...(optionsSnapshot === undefined
            ? {}
            : { options: optionsSnapshot }),
        });
        return structuredClone(result.value);
      },
      listChanges: async () => {
        await this.client.ensureInitialized();
        const result = await this.client.request({
          kind: "workspace_list_changes",
          workspace,
        });
        return structuredClone(result.value);
      },
      getChange: async (changeId) => {
        await this.client.ensureInitialized();
        const result = await this.client.request({
          kind: "workspace_get_change",
          workspace,
          change_id: changeId,
        });
        return structuredClone(result.value);
      },
      revertChange: async (changeId) => {
        await this.client.ensureInitialized();
        const result = await this.client.request({
          kind: "workspace_revert_change",
          workspace,
          change_id: changeId,
        });
        return structuredClone(result.value);
      },
    };
  }
}

export type NativeWorkspaceBackendOptions = {
  default_initial_files?: VfsSeedSource;
};

function isVfsSeedFileArray(
  source: VfsSeedSource,
): source is readonly Readonly<VfsSeedFile>[] {
  return Array.isArray(source);
}

/**
 * Keeps malformed runtime values JSON-safe without validating them here.
 *
 * Rust validates entries after it atomically checks workspace existence, so
 * callers consistently receive `already_exists` before a seed-data error.
 */
function encodeNativeInitialFiles(
  files: unknown,
): readonly unknown[] {
  if (!Array.isArray(files)) return [null];
  return files.map((file) => {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      typeof file.content !== "string"
    ) {
      return null;
    }
    return {
      path: file.path,
      content: file.content,
    };
  });
}

function requireWorkspaceHandle(
  value: NativeWorkspaceHandle,
  expectedProjectId: string,
): NativeWorkspaceHandle {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.project_id !== "string" ||
    value.project_id !== expectedProjectId ||
    typeof value.incarnation_id !== "string" ||
    value.incarnation_id.length === 0
  ) {
    throw new Error("Native storage returned an invalid workspace handle.");
  }
  return structuredClone(value);
}

function createAbortError(): DOMException {
  return new DOMException(
    "The native workspace snapshot was aborted.",
    "AbortError",
  );
}
