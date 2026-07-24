import {
  assertVfsWriteExpectation,
  compareVfsEntries,
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
  type WorkspaceChangeRecord,
  type WorkspaceChangesResult,
  type WorkspaceListResult,
  type WorkspaceReadResult,
  type WorkspaceRemoveResult,
  type WorkspaceWriteResult,
} from "../filesystem.ts";

export class MemoryWorkspace implements Workspace {
  private readonly files = new Map<string, string>();
  private readonly changes = new Map<string, WorkspaceChangeRecord>();
  private workspaceRevision = 0;
  private lastChangeAt: string | null = null;

  constructor(seed: VfsSeedSource = {}) {
    const files = Array.isArray(seed)
      ? normalizeVfsInitialFiles(seed)
      : normalizeVfsSeedFiles(seed as Readonly<Record<string, string>>);
    for (const { path, content } of files) {
      this.files.set(path, content);
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
        content,
      };
    }
    if (this.hasDescendants(normalizedPath)) {
      throw new VfsError("is_directory", `Path is a directory: ${normalizedPath}`);
    }
    throw new VfsError("not_found", `File not found: ${normalizedPath}`);
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

    this.files.set(normalizedPath, content);
    if (result.change) {
      this.changes.set(result.change.change_id, { ...result.change });
      this.lastChangeAt = result.change.created_at;
    }
    this.workspaceRevision = workspaceRevision;
    return {
      workspace_revision: this.workspaceRevision,
      result,
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
