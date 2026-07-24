import type {
  VfsEntry,
  VfsWriteOptions,
  VfsWriteResult,
  Workspace,
  WorkspaceChangeRecord,
} from "@researchbox/vfs";

export type VersionedWorkspaceList = {
  workspace_revision: number;
  entries: VfsEntry[];
};

export type VersionedWorkspaceRead = {
  workspace_revision: number;
  content: string;
};

export type VersionedWorkspaceWrite = {
  workspace_revision: number;
  result: VfsWriteResult;
};

export class WorkspaceController {
  private readonly filesystem: Workspace;
  private operationTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private workspaceRevision = 0;
  private lastChangeTimestamp = -1;

  constructor(filesystem: Workspace) {
    this.filesystem = filesystem;
  }

  get revision(): number {
    return this.workspaceRevision;
  }

  list(path: string): Promise<VersionedWorkspaceList> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      return {
        workspace_revision: this.workspaceRevision,
        entries: await this.filesystem.list(path),
      };
    });
  }

  read(path: string): Promise<VersionedWorkspaceRead> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      return {
        workspace_revision: this.workspaceRevision,
        content: await this.filesystem.read(path),
      };
    });
  }

  write(
    path: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<VersionedWorkspaceWrite> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      const writeOptions = this.withMonotonicChangeTime(options);
      const result = await this.filesystem.write(path, content, writeOptions);
      if (result.change_kind !== "unchanged") {
        this.workspaceRevision += 1;
        if (result.change) {
          this.lastChangeTimestamp = Date.parse(result.change.created_at);
        }
      }
      return {
        workspace_revision: this.workspaceRevision,
        result,
      };
    });
  }

  listChanges(): Promise<WorkspaceChangeRecord[]> {
    return this.enqueue(async () => {
      await this.ensureInitialized();
      return this.filesystem.listChanges();
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const changes = await this.filesystem.listChanges();
    this.workspaceRevision = changes.length;
    this.lastChangeTimestamp = changes.reduce((latest, change) => {
      const timestamp = Date.parse(change.created_at);
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, -1);
    this.initialized = true;
  }

  private withMonotonicChangeTime(
    options: VfsWriteOptions | undefined,
  ): VfsWriteOptions | undefined {
    if (!options?.change) return options;
    const candidate = Date.parse(options.change.created_at);
    const requestedTimestamp = Number.isFinite(candidate)
      ? candidate
      : Date.now();
    const timestamp = Math.max(requestedTimestamp, this.lastChangeTimestamp + 1);
    return {
      ...options,
      change: {
        ...options.change,
        created_at: new Date(timestamp).toISOString(),
      },
    };
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
