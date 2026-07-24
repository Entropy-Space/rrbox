import {
  applyWorkspaceChangeRevision,
  assertValidWorkspaceChangeRecord,
  assertVfsWriteExpectation,
  compareVfsEntries,
  compareVfsStrings,
  compareWorkspaceChanges,
  createVfsWriteResult,
  incrementWorkspaceRevision,
  normalizeFilePath,
  normalizePath,
  normalizeWorkspaceChangeTimestamp,
  normalizeVfsInitialFiles,
  normalizeVfsSeedFiles,
  VfsError,
  type VfsEntry,
  type VfsRemoveOptions,
  type VfsSeedSource,
  type VfsWriteOptions,
  type Workspace,
  type WorkspaceChangeResult,
  type WorkspaceChangeRevertResult,
  type WorkspaceChangeRecord,
  type WorkspaceChangesResult,
  type WorkspaceFilesSnapshotOptions,
  type WorkspaceFilesSnapshotResult,
  type WorkspaceListResult,
  type WorkspaceReadResult,
  type WorkspaceRemoveResult,
  type WorkspaceWriteResult,
} from "../filesystem.ts";

export class MemoryWorkspace implements Workspace {
  private readonly files = new Map<string, string>();
  private readonly pathRevisions = new Map<string, number>();
  private readonly changes = new Map<string, WorkspaceChangeRecord>();
  private workspaceRevision = 0;
  private lastChangeAt: string | null = null;

  constructor(seed: VfsSeedSource = {}) {
    const files = Array.isArray(seed)
      ? normalizeVfsInitialFiles(seed)
      : normalizeVfsSeedFiles(seed as Readonly<Record<string, string>>);
    for (const { path, content } of files) {
      this.files.set(path, content);
      this.pathRevisions.set(path, 0);
    }
  }

  async list(path: string): Promise<WorkspaceListResult> {
    const normalizedPath = normalizePath(path);
    if (this.files.has(normalizedPath)) {
      throw new VfsError(
        "not_directory",
        `Expected a directory but found a file: ${normalizedPath}`,
      );
    }

    const directory = normalizedPath === "/" ? "/" : `${normalizedPath}/`;
    const entries = new Map<string, VfsEntry>();

    for (const [filePath, content] of this.files) {
      if (!filePath.startsWith(directory)) continue;

      const remainder = filePath.slice(directory.length);
      if (!remainder) continue;

      const [name, ...rest] = remainder.split("/");
      if (!name) continue;

      const entryPath = `${directory}${name}`.replace("//", "/");
      if (rest.length > 0) {
        entries.set(name, {
          name,
          path: entryPath,
          kind: "directory",
          size: 0,
        });
      } else {
        entries.set(name, {
          name,
          path: entryPath,
          kind: "file",
          size: new TextEncoder().encode(content).byteLength,
        });
      }
    }

    return {
      workspace_revision: this.workspaceRevision,
      entries: [...entries.values()].sort(compareVfsEntries),
    };
  }

  async read(path: string): Promise<WorkspaceReadResult> {
    const normalizedPath = normalizeFilePath(path);
    const content = this.files.get(normalizedPath);
    if (content !== undefined) {
      return {
        workspace_revision: this.workspaceRevision,
        path_revision: this.pathRevisions.get(normalizedPath) ?? 0,
        content,
      };
    }
    if (this.hasDescendants(normalizedPath)) {
      throw new VfsError("is_directory", `Path is a directory: ${normalizedPath}`);
    }
    throw new VfsError("not_found", `File not found: ${normalizedPath}`);
  }

  async readFilesSnapshot(
    options?: WorkspaceFilesSnapshotOptions,
  ): Promise<WorkspaceFilesSnapshotResult> {
    throwIfAborted(options?.signal);
    return {
      workspace_revision: this.workspaceRevision,
      files: [...this.files]
        .map(([path, content]) => ({ path, content }))
        .sort((left, right) => compareVfsStrings(left.path, right.path)),
    };
  }

  async write(
    path: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<WorkspaceWriteResult> {
    const normalizedPath = normalizeFilePath(path);
    this.assertWritablePath(normalizedPath);
    const beforeContent = this.files.get(normalizedPath) ?? null;
    assertVfsWriteExpectation(normalizedPath, beforeContent, options);
    const change =
      options?.change === undefined
        ? undefined
        : normalizeWorkspaceChangeTimestamp(
            options.change,
            this.lastChangeAt,
          );
    const result = createVfsWriteResult(
      normalizedPath,
      beforeContent,
      content,
      change,
    );
    if (result.change_kind === "unchanged") {
      return {
        workspace_revision: this.workspaceRevision,
        result,
      };
    }
    if (result.change && this.changes.has(result.change.change_id)) {
      throw new VfsError(
        "conflict",
        `Workspace change already exists: ${result.change.change_id}`,
      );
    }
    const workspaceRevision = incrementWorkspaceRevision(
      this.workspaceRevision,
    );
    const committedResult = applyWorkspaceChangeRevision(
      result,
      workspaceRevision,
    );

    this.files.set(normalizedPath, content);
    this.pathRevisions.set(normalizedPath, workspaceRevision);
    if (committedResult.change) {
      this.changes.set(
        committedResult.change.change_id,
        { ...committedResult.change },
      );
      this.lastChangeAt = committedResult.change.created_at;
    }
    this.workspaceRevision = workspaceRevision;
    return {
      workspace_revision: this.workspaceRevision,
      result: committedResult,
    };
  }

  async remove(
    path: string,
    options?: VfsRemoveOptions,
  ): Promise<WorkspaceRemoveResult> {
    const normalizedPath = normalizeFilePath(path);
    const content = this.files.get(normalizedPath);
    if (content === undefined) {
      if (this.hasDescendants(normalizedPath)) {
        throw new VfsError(
          "is_directory",
          `Cannot remove a directory as a file: ${normalizedPath}`,
        );
      }
      throw new VfsError("not_found", `File not found: ${normalizedPath}`);
    }
    if (
      options?.expected_content !== undefined &&
      options.expected_content !== content
    ) {
      throw new VfsError(
        "conflict",
        `File changed before it could be removed: ${normalizedPath}`,
      );
    }
    const workspaceRevision = incrementWorkspaceRevision(
      this.workspaceRevision,
    );
    this.files.delete(normalizedPath);
    this.pathRevisions.delete(normalizedPath);
    this.workspaceRevision = workspaceRevision;
    return {
      workspace_revision: this.workspaceRevision,
    };
  }

  async listChanges(): Promise<WorkspaceChangesResult> {
    return {
      workspace_revision: this.workspaceRevision,
      changes: [...this.changes.values()]
        .sort(compareWorkspaceChanges)
        .map((change) => ({ ...change })),
    };
  }

  async getChange(changeId: string): Promise<WorkspaceChangeResult> {
    const change = this.changes.get(changeId);
    return {
      workspace_revision: this.workspaceRevision,
      change: change === undefined ? null : { ...change },
    };
  }

  async revertChange(
    changeId: string,
  ): Promise<WorkspaceChangeRevertResult> {
    const change = this.changes.get(changeId);
    if (change === undefined) {
      throw new VfsError(
        "not_found",
        `Workspace change not found: ${changeId}`,
      );
    }
    assertValidWorkspaceChangeRecord(
      change,
      this.workspaceRevision,
    );
    if (change.reverted_at_workspace_revision !== null) {
      return {
        workspace_revision: this.workspaceRevision,
        revert_outcome: "already_reverted",
        reverted_at_workspace_revision:
          change.reverted_at_workspace_revision,
        change: { ...change },
      };
    }
    if (change.applied_workspace_revision === null) {
      throw new VfsError(
        "conflict",
        `Workspace change has no safe path revision: ${changeId}`,
      );
    }

    const content = this.files.get(change.path);
    const pathRevision = this.pathRevisions.get(change.path);
    if (
      content === undefined ||
      content !== change.after_content ||
      pathRevision !== change.applied_workspace_revision ||
      (change.change_kind === "created" &&
        change.before_content !== null) ||
      (change.change_kind === "updated" &&
        change.before_content === null)
    ) {
      throw new VfsError(
        "conflict",
        `Workspace path changed after receipt was created: ${change.path}`,
      );
    }

    const workspaceRevision = incrementWorkspaceRevision(
      this.workspaceRevision,
    );
    if (change.change_kind === "created") {
      this.files.delete(change.path);
      this.pathRevisions.delete(change.path);
    } else {
      const beforeContent = change.before_content;
      if (beforeContent === null) {
        throw new VfsError(
          "conflict",
          `Workspace change cannot be safely reverted: ${changeId}`,
        );
      }
      this.files.set(change.path, beforeContent);
      this.pathRevisions.set(change.path, workspaceRevision);
    }
    const revertedChange = {
      ...change,
      reverted_at_workspace_revision: workspaceRevision,
    } satisfies WorkspaceChangeRecord;
    this.changes.set(changeId, revertedChange);
    this.workspaceRevision = workspaceRevision;
    return {
      workspace_revision: workspaceRevision,
      revert_outcome: "applied",
      reverted_at_workspace_revision: workspaceRevision,
      change: { ...revertedChange },
    };
  }

  private assertWritablePath(normalizedPath: string): void {
    if (this.hasDescendants(normalizedPath)) {
      throw new VfsError(
        "is_directory",
        `Cannot replace a directory with a file: ${normalizedPath}`,
      );
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = `/${segments.slice(0, index).join("/")}`;
      if (this.files.has(ancestor)) {
        throw new VfsError(
          "not_directory",
          `Cannot create a file beneath another file: ${ancestor}`,
        );
      }
    }
  }

  private hasDescendants(path: string): boolean {
    const prefix = `${path}/`;
    return [...this.files.keys()].some((candidate) => candidate.startsWith(prefix));
  }
}

/** @deprecated Use `MemoryWorkspace`. */
export { MemoryWorkspace as MemoryFileSystem };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ??
    new DOMException("The workspace snapshot was aborted.", "AbortError");
}
