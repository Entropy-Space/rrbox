import {
  normalizeFilePath,
  normalizePath,
  VfsError,
  type VfsEntry,
  type VirtualFileSystem,
} from "../filesystem.ts";

export class MemoryFileSystem implements VirtualFileSystem {
  private readonly files = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) {
      this.setFile(path, content);
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

  async write(path: string, content: string): Promise<void> {
    this.setFile(path, content);
  }

  private setFile(path: string, content: string): void {
    const normalizedPath = normalizeFilePath(path);
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

    this.files.set(normalizedPath, content);
  }

  private hasDescendants(path: string): boolean {
    const prefix = `${path}/`;
    return [...this.files.keys()].some((candidate) => candidate.startsWith(prefix));
  }
}
