import {
  assertVfsWriteExpectation,
  createVfsWriteResult,
  normalizeFilePath,
  normalizePath,
  normalizeVfsSeedFiles,
  VfsError,
  type VfsEntry,
  type VfsRemoveOptions,
  type VfsWriteOptions,
  type VfsWriteResult,
  type VirtualFileSystem,
  type WorkspaceChangeRecord,
} from "../filesystem.ts";

export class MemoryFileSystem implements VirtualFileSystem {
  private readonly files = new Map<string, string>();
  private readonly changes = new Map<string, WorkspaceChangeRecord>();

  constructor(seed: Record<string, string> = {}) {
    for (const { path, content } of normalizeVfsSeedFiles(seed)) {
      this.files.set(path, content);
    }
  }

  async list(path: string): Promise<VfsEntry[]> {
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

    return [...entries.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  async read(path: string): Promise<string> {
    const normalizedPath = normalizeFilePath(path);
    const content = this.files.get(normalizedPath);
    if (content !== undefined) return content;
    if (this.hasDescendants(normalizedPath)) {
      throw new VfsError("is_directory", `Path is a directory: ${normalizedPath}`);
    }
    throw new VfsError("not_found", `File not found: ${normalizedPath}`);
  }

  async write(
    path: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<VfsWriteResult> {
    const normalizedPath = normalizeFilePath(path);
    this.assertWritablePath(normalizedPath);
    const beforeContent = this.files.get(normalizedPath) ?? null;
    assertVfsWriteExpectation(normalizedPath, beforeContent, options);
    const result = createVfsWriteResult(
      normalizedPath,
      beforeContent,
      content,
      options?.change,
    );
    if (result.change_kind === "unchanged") return result;
    if (result.change && this.changes.has(result.change.change_id)) {
      throw new VfsError(
        "conflict",
        `Workspace change already exists: ${result.change.change_id}`,
      );
    }

    this.files.set(normalizedPath, content);
    if (result.change) {
      this.changes.set(result.change.change_id, { ...result.change });
    }
    return result;
  }

  async remove(path: string, options?: VfsRemoveOptions): Promise<void> {
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
    this.files.delete(normalizedPath);
  }

  async listChanges(): Promise<WorkspaceChangeRecord[]> {
    return [...this.changes.values()]
      .sort((left, right) =>
        left.created_at === right.created_at
          ? left.change_id.localeCompare(right.change_id)
          : left.created_at.localeCompare(right.created_at),
      )
      .map((change) => ({ ...change }));
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
