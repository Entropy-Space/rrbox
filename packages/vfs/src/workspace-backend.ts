import {
  incrementWorkspaceRevision,
  isWorkspaceFilesSnapshotReader,
  normalizeVfsInitialFiles,
  offsetWorkspaceRevision,
  VfsError,
  type VfsSeedFile,
  type Workspace,
  type WorkspaceChangeRecord,
  type WorkspaceChangeResult,
  type WorkspaceChangeRevertResult,
  type WorkspaceChangesResult,
  type WorkspaceFilesSnapshotReader,
  type WorkspaceReadResult,
  type WorkspaceWriteResult,
} from "./filesystem.ts";

export type WorkspaceBackendErrorCode =
  | "already_exists"
  | "not_found";

export class WorkspaceBackendError extends Error {
  public readonly code: WorkspaceBackendErrorCode;

  constructor(code: WorkspaceBackendErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceBackendError";
    this.code = code;
  }
}

/**
 * Files supplied by an import or another caller when creating a workspace.
 *
 * Omitting `initial_files` preserves the backend's configured default seed.
 * Providing it, including an empty array, replaces that seed. Initial files
 * belong to the new incarnation's baseline: they do not increment its revision
 * and do not create workspace change records.
 */
export type WorkspaceCreateOptions = {
  initial_files?: readonly Readonly<VfsSeedFile>[];
};

/**
 * Captures caller-owned options without validating them. Backends can therefore
 * preserve `already_exists` precedence while preventing queued work from
 * observing later array or file-object mutations.
 */
export function snapshotWorkspaceCreateOptions(
  options?: WorkspaceCreateOptions,
): WorkspaceCreateOptions | undefined {
  if (options?.initial_files === undefined) return undefined;
  const initialFiles = options.initial_files;
  return {
    initial_files: Array.isArray(initialFiles)
      ? initialFiles.map((file) =>
          typeof file === "object" && file !== null
            ? { path: file.path, content: file.content }
            : file,
        )
      : initialFiles,
  };
}

/**
 * Owns project-scoped workspace lifecycle.
 *
 * `create` rejects an existing project with `WorkspaceBackendError` code
 * `already_exists`; `open` rejects a missing project with code `not_found`;
 * `delete` is idempotent.
 *
 * Every handle returned by `create` or `open` represents one workspace
 * incarnation. All of its methods reject with `VfsError` code `not_found`
 * after deletion and `conflict` after replacement. Successful operations carry
 * the authoritative revision observed or committed by that same operation.
 * Reusing a deleted project id continues its revision sequence so cached
 * project-scoped data can never mistake a replacement for older content.
 * Deleting an active workspace reserves exactly one revision for that
 * replacement baseline; repeating the idempotent delete reserves none.
 * Backend-specific optional behavior belongs in separate capability interfaces
 * instead of runtime flags in the agent core.
 */
export interface WorkspaceBackend {
  create(
    projectId: string,
    options?: WorkspaceCreateOptions,
  ): Promise<Workspace>;
  open(projectId: string): Promise<Workspace>;
  delete(projectId: string): Promise<void>;
}

/**
 * Optional lifecycle repair for durable backends that can enumerate their
 * active project workspaces.
 *
 * A successful call removes every active workspace whose project id is absent
 * from `retainedProjectIds`. Deleted tombstones may be preserved so workspace
 * revision sequences remain monotonic if an id is reused.
 */
export interface WorkspaceOrphanReconciler {
  reconcileOrphanedWorkspaces(
    retainedProjectIds: readonly string[],
  ): Promise<void>;
}

export function isWorkspaceOrphanReconciler(
  backend: WorkspaceBackend,
): backend is WorkspaceBackend & WorkspaceOrphanReconciler {
  return (
    typeof (backend as Partial<WorkspaceOrphanReconciler>)
      .reconcileOrphanedWorkspaces === "function"
  );
}

type MemoryWorkspaceRecord = {
  workspace: Workspace;
  revisionOffset: number;
  localRevision: number;
};

export class MemoryWorkspaceBackend implements WorkspaceBackend {
  private readonly workspaces = new Map<string, MemoryWorkspaceRecord>();
  private readonly tombstoneRevisions = new Map<string, number>();
  private readonly createWorkspace: (
    initialFiles?: readonly VfsSeedFile[],
  ) => Workspace;
  private operationTail: Promise<void> = Promise.resolve();

  /**
   * The factory must return a distinct revision-zero workspace on every call.
   * When initial files are provided, it must use them instead of its configured
   * default seed.
   */
  constructor(
    createWorkspace: (
      initialFiles?: readonly VfsSeedFile[],
    ) => Workspace,
  ) {
    this.createWorkspace = createWorkspace;
  }

  create(
    projectId: string,
    options?: WorkspaceCreateOptions,
  ): Promise<Workspace> {
    const createOptions = snapshotWorkspaceCreateOptions(options);
    return this.enqueue(async () => {
      if (this.workspaces.has(projectId)) {
        throw new WorkspaceBackendError(
          "already_exists",
          `Project workspace already exists: ${projectId}`,
        );
      }
      const initialFiles =
        createOptions?.initial_files === undefined
          ? undefined
          : normalizeVfsInitialFiles(createOptions.initial_files);
      const record = {
        workspace: this.createWorkspace(initialFiles),
        revisionOffset: this.tombstoneRevisions.get(projectId) ?? 0,
        localRevision: 0,
      } satisfies MemoryWorkspaceRecord;
      this.workspaces.set(projectId, record);
      this.tombstoneRevisions.delete(projectId);
      return this.createHandle(projectId, record);
    });
  }

  open(projectId: string): Promise<Workspace> {
    return this.enqueue(async () => {
      const record = this.workspaces.get(projectId);
      if (!record) {
        throw new WorkspaceBackendError(
          "not_found",
          `Project workspace does not exist: ${projectId}`,
        );
      }
      return this.createHandle(projectId, record);
    });
  }

  delete(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      const record = this.workspaces.get(projectId);
      if (!record) return;
      await this.deleteRecord(projectId, record);
    });
  }

  reconcileOrphanedWorkspaces(
    retainedProjectIds: readonly string[],
  ): Promise<void> {
    const retained = new Set(retainedProjectIds);
    return this.enqueue(async () => {
      for (const [projectId, record] of this.workspaces) {
        if (retained.has(projectId)) continue;
        await this.deleteRecord(projectId, record);
      }
    });
  }

  private createHandle(
    projectId: string,
    record: MemoryWorkspaceRecord,
  ): Workspace {
    const handle: Workspace & Partial<WorkspaceFilesSnapshotReader> = {
      list: (path) =>
        this.runOnRecord(projectId, record, async () =>
          this.withRevisionOffset(
            record,
            await record.workspace.list(path),
          )),
      read: (path) =>
        this.runOnRecord(projectId, record, async () =>
          this.withReadRevisionOffset(
            record,
            await record.workspace.read(path),
          )),
      write: (path, content, options) =>
        this.runOnRecord(projectId, record, async () => {
          await this.assertWriteRevisionCapacity(record, path, content);
          return this.withWriteRevisionOffset(
            record,
            await record.workspace.write(path, content, options),
          );
        }),
      remove: (path, options) =>
        this.runOnRecord(projectId, record, async () => {
          const existing = await record.workspace.read(path);
          record.localRevision = existing.workspace_revision;
          this.assertMutationRevisionCapacity(record);
          return this.withRevisionOffset(
            record,
            await record.workspace.remove(path, options),
          );
        }),
      listChanges: () =>
        this.runOnRecord(projectId, record, async () =>
          this.withChangesRevisionOffset(
            record,
            await record.workspace.listChanges(),
          )),
      getChange: (changeId) =>
        this.runOnRecord(projectId, record, async () =>
          this.withChangeRevisionOffset(
            record,
            await record.workspace.getChange(changeId),
          )),
      revertChange: (changeId) =>
        this.runOnRecord(projectId, record, async () => {
          const receipt = await record.workspace.getChange(changeId);
          record.localRevision = receipt.workspace_revision;
          if (
            receipt.change !== null &&
            receipt.change.reverted_at_workspace_revision === null
          ) {
            this.assertMutationRevisionCapacity(record);
          }
          return this.withChangeRevertRevisionOffset(
            record,
            await record.workspace.revertChange(changeId),
          );
        }),
    };
    const filesystem = record.workspace;
    if (isWorkspaceFilesSnapshotReader(filesystem)) {
      handle.readFilesSnapshot = (options) =>
        this.runOnRecord(projectId, record, async () =>
          this.withRevisionOffset(
            record,
            await filesystem.readFilesSnapshot(options),
          ));
    }
    return handle;
  }

  private async deleteRecord(
    projectId: string,
    record: MemoryWorkspaceRecord,
  ): Promise<void> {
    const listing = await record.workspace.list("/");
    record.localRevision = listing.workspace_revision;
    const currentRevision = offsetWorkspaceRevision(
      listing.workspace_revision,
      record.revisionOffset,
    );
    const tombstoneRevision = incrementWorkspaceRevision(currentRevision);
    this.workspaces.delete(projectId);
    this.tombstoneRevisions.set(projectId, tombstoneRevision);
  }

  private runOnRecord<T>(
    projectId: string,
    record: MemoryWorkspaceRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const activeRecord = this.workspaces.get(projectId);
      if (!activeRecord) {
        throw new VfsError(
          "not_found",
          `Project workspace no longer exists: ${projectId}`,
        );
      }
      if (activeRecord !== record) {
        throw new VfsError(
          "conflict",
          `Project workspace handle is stale: ${projectId}`,
        );
      }
      return operation();
    });
  }

  private withRevisionOffset<T extends { workspace_revision: number }>(
    record: MemoryWorkspaceRecord,
    result: T,
  ): T {
    const workspaceRevision = offsetWorkspaceRevision(
      result.workspace_revision,
      record.revisionOffset,
    );
    record.localRevision = result.workspace_revision;
    return {
      ...result,
      workspace_revision: workspaceRevision,
    };
  }

  private withReadRevisionOffset(
    record: MemoryWorkspaceRecord,
    result: WorkspaceReadResult,
  ): WorkspaceReadResult {
    return {
      ...this.withRevisionOffset(record, result),
      path_revision: offsetWorkspaceRevision(
        result.path_revision,
        record.revisionOffset,
      ),
    };
  }

  private withWriteRevisionOffset(
    record: MemoryWorkspaceRecord,
    result: WorkspaceWriteResult,
  ): WorkspaceWriteResult {
    return {
      ...this.withRevisionOffset(record, result),
      result: {
        ...result.result,
        change:
          result.result.change === null
            ? null
            : this.withChangeRecordRevisionOffset(
                record,
                result.result.change,
              ),
      },
    };
  }

  private withChangesRevisionOffset(
    record: MemoryWorkspaceRecord,
    result: WorkspaceChangesResult,
  ): WorkspaceChangesResult {
    return {
      ...this.withRevisionOffset(record, result),
      changes: result.changes.map((change) =>
        this.withChangeRecordRevisionOffset(record, change),
      ),
    };
  }

  private withChangeRevisionOffset(
    record: MemoryWorkspaceRecord,
    result: WorkspaceChangeResult,
  ): WorkspaceChangeResult {
    return {
      ...this.withRevisionOffset(record, result),
      change:
        result.change === null
          ? null
          : this.withChangeRecordRevisionOffset(record, result.change),
    };
  }

  private withChangeRevertRevisionOffset(
    record: MemoryWorkspaceRecord,
    result: WorkspaceChangeRevertResult,
  ): WorkspaceChangeRevertResult {
    return {
      ...this.withRevisionOffset(record, result),
      reverted_at_workspace_revision: offsetWorkspaceRevision(
        result.reverted_at_workspace_revision,
        record.revisionOffset,
      ),
      change: this.withChangeRecordRevisionOffset(
        record,
        result.change,
      ),
    };
  }

  private withChangeRecordRevisionOffset(
    record: MemoryWorkspaceRecord,
    change: WorkspaceChangeRecord,
  ): WorkspaceChangeRecord {
    return {
      ...change,
      applied_workspace_revision:
        change.applied_workspace_revision === null
          ? null
          : offsetWorkspaceRevision(
              change.applied_workspace_revision,
              record.revisionOffset,
            ),
      reverted_at_workspace_revision:
        change.reverted_at_workspace_revision === null
          ? null
          : offsetWorkspaceRevision(
              change.reverted_at_workspace_revision,
              record.revisionOffset,
            ),
    };
  }

  private async assertWriteRevisionCapacity(
    record: MemoryWorkspaceRecord,
    path: string,
    content: string,
  ): Promise<void> {
    try {
      const existing = await record.workspace.read(path);
      record.localRevision = existing.workspace_revision;
      if (existing.content !== content) {
        this.assertMutationRevisionCapacity(record);
      }
    } catch (error) {
      if (error instanceof VfsError && error.code === "not_found") {
        this.assertMutationRevisionCapacity(record);
        return;
      }
      throw error;
    }
  }

  private assertMutationRevisionCapacity(
    record: MemoryWorkspaceRecord,
  ): void {
    offsetWorkspaceRevision(
      incrementWorkspaceRevision(record.localRevision),
      record.revisionOffset,
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
