import type {
  VfsRemoveOptions,
  VfsWriteOptions,
  Workspace,
  WorkspaceChangesResult,
  WorkspaceListResult,
  WorkspaceReadResult,
  WorkspaceRemoveResult,
  WorkspaceWriteResult,
} from "@researchbox/vfs";

/** @deprecated Use `WorkspaceListResult` from `@researchbox/vfs`. */
export type VersionedWorkspaceList = WorkspaceListResult;

/** @deprecated Use `WorkspaceReadResult` from `@researchbox/vfs`. */
export type VersionedWorkspaceRead = WorkspaceReadResult;

/** @deprecated Use `WorkspaceWriteResult` from `@researchbox/vfs`. */
export type VersionedWorkspaceWrite = WorkspaceWriteResult;

export class WorkspaceController implements Workspace {
  private readonly filesystem: Workspace;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(filesystem: Workspace) {
    this.filesystem = filesystem;
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
