import {
  isWorkspaceFilesSnapshotReader,
  type VfsRemoveOptions,
  type VfsWriteOptions,
  type Workspace,
  type WorkspaceChangeResult,
  type WorkspaceChangeRevertResult,
  type WorkspaceChangesResult,
  type WorkspaceFilesSnapshotOptions,
  type WorkspaceFilesSnapshotReader,
  type WorkspaceFilesSnapshotResult,
  type WorkspaceListResult,
  type WorkspaceReadResult,
  type WorkspaceRemoveResult,
  type WorkspaceWriteResult,
} from "@researchbox/vfs";

/** @deprecated Use `WorkspaceListResult` from `@researchbox/vfs`. */
export type VersionedWorkspaceList = WorkspaceListResult;

/** @deprecated Use `WorkspaceReadResult` from `@researchbox/vfs`. */
export type VersionedWorkspaceRead = WorkspaceReadResult;

/** @deprecated Use `WorkspaceWriteResult` from `@researchbox/vfs`. */
export type VersionedWorkspaceWrite = WorkspaceWriteResult;

export class WorkspaceController implements Workspace {
  readonly readFilesSnapshot?: WorkspaceFilesSnapshotReader["readFilesSnapshot"];

  private readonly filesystem: Workspace;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(filesystem: Workspace) {
    this.filesystem = filesystem;
    if (isWorkspaceFilesSnapshotReader(filesystem)) {
      this.readFilesSnapshot = (
        options?: WorkspaceFilesSnapshotOptions,
      ): Promise<WorkspaceFilesSnapshotResult> =>
        this.enqueue(() => {
          throwIfAborted(options?.signal);
          return filesystem.readFilesSnapshot(options);
        });
    }
  }

  list(path: string): Promise<WorkspaceListResult> {
    return this.enqueue(() => this.filesystem.list(path));
  }

  read(path: string): Promise<WorkspaceReadResult> {
    return this.enqueue(() => this.filesystem.read(path));
  }

  write(
    path: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<WorkspaceWriteResult> {
    return this.enqueue(() => this.filesystem.write(path, content, options));
  }

  remove(
    path: string,
    options?: VfsRemoveOptions,
  ): Promise<WorkspaceRemoveResult> {
    return this.enqueue(() => this.filesystem.remove(path, options));
  }

  listChanges(): Promise<WorkspaceChangesResult> {
    return this.enqueue(() => this.filesystem.listChanges());
  }

  getChange(changeId: string): Promise<WorkspaceChangeResult> {
    return this.enqueue(() => this.filesystem.getChange(changeId));
  }

  revertChange(
    changeId: string,
  ): Promise<WorkspaceChangeRevertResult> {
    return this.enqueue(() => this.filesystem.revertChange(changeId));
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ??
    new DOMException("The operation was aborted.", "AbortError");
}
