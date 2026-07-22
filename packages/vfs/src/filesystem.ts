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
  | "is_directory"
  | "conflict";

export type WorkspaceChangeMetadata = {
  change_id: string;
  session_id: string;
  message_id: string;
  assistant_message_index: number;
  tool_call_id: string;
  tool_name: "write_file" | "replace_text";
  created_at: string;
};

export type WorkspaceChangeRecord = WorkspaceChangeMetadata & {
  path: string;
  change_kind: "created" | "updated";
  before_content: string | null;
  after_content: string;
  additions: number;
  deletions: number;
  byte_size: number;
};

export type VfsWriteOptions = {
  expected_content?: string | null;
  change?: WorkspaceChangeMetadata;
};

export type VfsWriteResult = {
  path: string;
  change_kind: "created" | "updated" | "unchanged";
  before_content: string | null;
  after_content: string;
  change: WorkspaceChangeRecord | null;
};

export type VfsRemoveOptions = {
  expected_content?: string;
};

export type VfsSeedFile = {
  path: string;
  content: string;
};

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
  write(
    path: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<VfsWriteResult>;
  remove(path: string, options?: VfsRemoveOptions): Promise<void>;
  listChanges(): Promise<WorkspaceChangeRecord[]>;
}

export function createVfsWriteResult(
  path: string,
  beforeContent: string | null,
  afterContent: string,
  change?: WorkspaceChangeMetadata,
): VfsWriteResult {
  const normalizedPath = normalizeFilePath(path);
  if (beforeContent === afterContent) {
    return {
      path: normalizedPath,
      change_kind: "unchanged",
      before_content: beforeContent,
      after_content: afterContent,
      change: null,
    };
  }

  const changeKind = beforeContent === null ? "created" : "updated";
  return {
    path: normalizedPath,
    change_kind: changeKind,
    before_content: beforeContent,
    after_content: afterContent,
    change:
      change === undefined
        ? null
        : {
            ...change,
            path: normalizedPath,
            change_kind: changeKind,
            before_content: beforeContent,
            after_content: afterContent,
            ...computeLineChanges(beforeContent ?? "", afterContent),
            byte_size: new TextEncoder().encode(afterContent).byteLength,
          },
  };
}

export function assertVfsWriteExpectation(
  path: string,
  beforeContent: string | null,
  options?: VfsWriteOptions,
): void {
  if (options?.expected_content === undefined) return;
  if (options.expected_content === beforeContent) return;
  throw new VfsError(
    "conflict",
    `File changed before the write could be applied: ${normalizeFilePath(path)}`,
  );
}

export function normalizeVfsSeedFiles(
  seed: Readonly<Record<string, string>>,
): VfsSeedFile[] {
  const normalizedFiles = new Map<string, string>();
  for (const [path, content] of Object.entries(seed)) {
    const normalizedPath = normalizeFilePath(path);
    if (normalizedFiles.has(normalizedPath)) {
      throw new VfsError(
        "conflict",
        `Seed file resolves to a duplicate path: ${normalizedPath}`,
      );
    }
    if (
      [...normalizedFiles.keys()].some((candidate) =>
        candidate.startsWith(`${normalizedPath}/`),
      )
    ) {
      throw new VfsError(
        "is_directory",
        `Cannot replace a seed directory with a file: ${normalizedPath}`,
      );
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = `/${segments.slice(0, index).join("/")}`;
      if (normalizedFiles.has(ancestor)) {
        throw new VfsError(
          "not_directory",
          `Cannot create a seed file beneath another file: ${ancestor}`,
        );
      }
    }
    normalizedFiles.set(normalizedPath, content);
  }

  return [...normalizedFiles].map(([path, content]) => ({ path, content }));
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

function computeLineChanges(
  beforeContent: string,
  afterContent: string,
): { additions: number; deletions: number } {
  const beforeLines = splitLines(beforeContent);
  const afterLines = splitLines(afterContent);
  let prefixLength = 0;
  const sharedLength = Math.min(beforeLines.length, afterLines.length);
  while (
    prefixLength < sharedLength &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < beforeLines.length - prefixLength &&
    suffixLength < afterLines.length - prefixLength &&
    beforeLines[beforeLines.length - suffixLength - 1] ===
      afterLines[afterLines.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  return {
    additions: afterLines.length - prefixLength - suffixLength,
    deletions: beforeLines.length - prefixLength - suffixLength,
  };
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    lines.push(content.slice(lineStart, index + 1));
    lineStart = index + 1;
  }
  if (lineStart < content.length) lines.push(content.slice(lineStart));
  return lines;
}
