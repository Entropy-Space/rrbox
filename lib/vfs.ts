export type VfsEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
};

export type VfsErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_directory"
  | "is_directory";

export class VfsError extends Error {
  public readonly code: VfsErrorCode;

  constructor(
    code: VfsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VfsError";
    this.code = code;
  }
}

export interface VirtualFileSystem {
  list(path: string): Promise<VfsEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

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

export function createSeededFileSystem(): MemoryFileSystem {
  return new MemoryFileSystem({
    "/README.md": [
      "# Researchbox",
      "",
      "A browser-native workspace for a Pi agent.",
      "",
      "## Architecture",
      "",
      "- The viewer speaks a versioned JSON protocol.",
      "- The agent core runs in a Web Worker.",
      "- Storage is provided through a virtual filesystem interface.",
    ].join("\n"),
    "/notes/product-brief.md": [
      "# Product brief",
      "",
      "Make powerful agent workflows feel as calm as a conversation.",
      "The browser is a first-class runtime, not a fallback.",
    ].join("\n"),
    "/src/agent.ts": [
      'export const system_prompt = "You are a careful research partner.";',
      "",
      "export type AgentRuntime = {",
      "  run(input: string): Promise<void>;",
      "};",
    ].join("\n"),
    "/src/tools.ts": [
      'export const tools = ["read_file", "write_file", "list_files"];',
    ].join("\n"),
  });
}

function normalizeFilePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    throw new VfsError("invalid_path", "Expected a file path.");
  }
  return normalized;
}

function normalizePath(path: string): string {
  if (typeof path !== "string") {
    throw new VfsError("invalid_path", "Path must be a string.");
  }

  const segments = path.replaceAll("\\", "/").split("/");
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) {
        throw new VfsError("invalid_path", "Path escapes the workspace.");
      }
      normalized.pop();
      continue;
    }
    if (segment.includes("\0")) {
      throw new VfsError("invalid_path", "Path contains a null byte.");
    }
    normalized.push(segment);
  }

  return `/${normalized.join("/")}`;
}
