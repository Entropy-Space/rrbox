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

  constructor(code: VfsErrorCode, message: string) {
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

export function normalizeFilePath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    throw new VfsError("invalid_path", "Expected a file path.");
  }
  return normalized;
}

export function normalizePath(path: string): string {
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
