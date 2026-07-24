import {
  VfsError,
  type Workspace,
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
 * Owns project-scoped workspace lifecycle.
 *
 * `create` rejects an existing project with `WorkspaceBackendError` code
 * `already_exists`; `open` rejects a missing project with code `not_found`;
 * `delete` is idempotent.
 *
 * Every handle returned by `create` or `open` represents one workspace
 * incarnation. All of its methods reject with `VfsError` code `not_found`
 * after deletion and `conflict` after replacement. Backend-specific optional
 * behavior belongs in separate capability interfaces instead of runtime flags
 * in the agent core.
 */
export interface WorkspaceBackend {
  create(projectId: string): Promise<Workspace>;
  open(projectId: string): Promise<Workspace>;
  delete(projectId: string): Promise<void>;
}

type MemoryWorkspaceRecord = {
  workspace: Workspace;
};

export class MemoryWorkspaceBackend implements WorkspaceBackend {
  private readonly workspaces = new Map<string, MemoryWorkspaceRecord>();
  private readonly createWorkspace: () => Workspace;

  constructor(createWorkspace: () => Workspace) {
    this.createWorkspace = createWorkspace;
  }

  async create(projectId: string): Promise<Workspace> {
    if (this.workspaces.has(projectId)) {
      throw new WorkspaceBackendError(
        "already_exists",
        `Project workspace already exists: ${projectId}`,
      );
    }
    const record = {
      workspace: this.createWorkspace(),
    } satisfies MemoryWorkspaceRecord;
    this.workspaces.set(projectId, record);
    return this.createHandle(projectId, record);
  }

  async open(projectId: string): Promise<Workspace> {
    const record = this.workspaces.get(projectId);
    if (!record) {
      throw new WorkspaceBackendError(
        "not_found",
        `Project workspace does not exist: ${projectId}`,
      );
    }
    return this.createHandle(projectId, record);
  }

  async delete(projectId: string): Promise<void> {
    this.workspaces.delete(projectId);
  }

  private createHandle(
    projectId: string,
    record: MemoryWorkspaceRecord,
  ): Workspace {
    const assertActive = () => {
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
    };

    return {
      async list(path) {
        assertActive();
        return record.workspace.list(path);
      },
      async read(path) {
        assertActive();
        return record.workspace.read(path);
      },
      async write(path, content, options) {
        assertActive();
        return record.workspace.write(path, content, options);
      },
      async remove(path, options) {
        assertActive();
        return record.workspace.remove(path, options);
      },
      async listChanges() {
        assertActive();
        return record.workspace.listChanges();
      },
    };
  }
}
