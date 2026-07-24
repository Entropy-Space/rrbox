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
  tool_call_block_id: string;
  assistant_message_index: number;
  tool_call_id: string;
  tool_name: "write_file" | "replace_text";
  created_at: string;
};

export type WorkspaceChangeRecord = Omit<
  WorkspaceChangeMetadata,
  "tool_call_block_id"
> & {
  tool_call_block_id: string | null;
  legacy_message_id?: string;
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

export type VfsSeedSource =
  | Readonly<Record<string, string>>
  | readonly Readonly<VfsSeedFile>[];

export type WorkspaceListResult = {
  workspace_revision: number;
  entries: VfsEntry[];
};

export type WorkspaceReadResult = {
  workspace_revision: number;
  content: string;
};

export type WorkspaceWriteResult = {
  workspace_revision: number;
  result: VfsWriteResult;
};

export type WorkspaceRemoveResult = {
  workspace_revision: number;
};

export type WorkspaceChangesResult = {
  workspace_revision: number;
  changes: WorkspaceChangeRecord[];
};

export class VfsError extends Error {
  public readonly code: VfsErrorCode;

  constructor(code: VfsErrorCode, message: string) {
    super(message);
    this.name = "VfsError";
    this.code = code;
  }
}

export interface WorkspaceReader {
  list(path: string): Promise<WorkspaceListResult>;
  read(path: string): Promise<WorkspaceReadResult>;
}

export interface WorkspaceWriter {
  write(
    path: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<WorkspaceWriteResult>;
  remove(
    path: string,
    options?: VfsRemoveOptions,
  ): Promise<WorkspaceRemoveResult>;
}

export interface WorkspaceChangeJournal {
  listChanges(): Promise<WorkspaceChangesResult>;
}

/**
 * A UTF-8 text workspace with implicit directories.
 *
 * Paths form a case-sensitive Unicode logical namespace. A native adapter must
 * preserve distinct spellings and normalization forms, using an encoded
 * physical representation or metadata when the host filesystem cannot do so.
 * The native on-disk representation is not part of this contract.
 *
 * A project's first workspace incarnation starts at revision zero; replacement
 * incarnations continue that project id's sequence, with lifecycle deletion
 * reserving their baseline revision. Every changed write or successful removal
 * increments the revision exactly once; unchanged and failed operations do not
 * increment it. Each operation returns the revision that was observed or
 * committed atomically with its result.
 *
 * Implementations must commit a changed file, its optional change receipt,
 * receipt clock, and revision atomically. They must also provide exact
 * compare-and-swap behavior through `expected_content`; these guarantees are
 * not optional backend capabilities.
 */
export interface Workspace
  extends WorkspaceReader,
    WorkspaceWriter,
    WorkspaceChangeJournal {}

/** @deprecated Use `Workspace`. */
export type VirtualFileSystem = Workspace;

export function compareVfsStrings(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const leftCodePoint = leftCodePoints[index]?.codePointAt(0) ?? 0;
    const rightCodePoint = rightCodePoints[index]?.codePointAt(0) ?? 0;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }

  if (leftCodePoints.length === rightCodePoints.length) return 0;
  return leftCodePoints.length < rightCodePoints.length ? -1 : 1;
}

export function compareVfsEntries(left: VfsEntry, right: VfsEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return compareVfsStrings(left.name, right.name);
}

export function compareWorkspaceChanges(
  left: Pick<WorkspaceChangeRecord, "change_id" | "created_at">,
  right: Pick<WorkspaceChangeRecord, "change_id" | "created_at">,
): number {
  return left.created_at === right.created_at
    ? compareVfsStrings(left.change_id, right.change_id)
    : compareVfsStrings(left.created_at, right.created_at);
}

export function normalizeWorkspaceChangeTimestamp(
  change: WorkspaceChangeMetadata,
  lastChangeAt: string | null,
): WorkspaceChangeMetadata {
  const candidate = Date.parse(change.created_at);
  const requestedTimestamp = Number.isFinite(candidate)
    ? candidate
    : Date.now();
  const previous = lastChangeAt === null ? NaN : Date.parse(lastChangeAt);
  const timestamp = Math.max(
    requestedTimestamp,
    Number.isFinite(previous) ? previous + 1 : requestedTimestamp,
  );
  return {
    ...change,
    created_at: new Date(timestamp).toISOString(),
  };
}

export function incrementWorkspaceRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new VfsError("conflict", "Workspace revision is invalid.");
  }
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new VfsError("conflict", "Workspace revision is exhausted.");
  }
  return revision + 1;
}

export function offsetWorkspaceRevision(
  revision: number,
  offset: number,
): number {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    revision > Number.MAX_SAFE_INTEGER - offset
  ) {
    throw new VfsError("conflict", "Workspace revision is invalid.");
  }
  return revision + offset;
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
  return normalizeVfsInitialFiles(
    Object.entries(seed).map(([path, content]) => ({ path, content })),
  );
}

export function normalizeVfsInitialFiles(
  files: readonly Readonly<VfsSeedFile>[],
): VfsSeedFile[] {
  if (!Array.isArray(files)) {
    throw new VfsError(
      "invalid_path",
      "Initial files must be an array.",
    );
  }
  const normalizedFiles = new Map<string, string>();
  const impliedDirectories = new Set<string>();
  for (const file of files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      typeof file.content !== "string"
    ) {
      throw new VfsError(
        "invalid_path",
        "Initial files must contain string paths and content.",
      );
    }
    const { path, content } = file;
    const normalizedPath = normalizeFilePath(path);
    if (normalizedFiles.has(normalizedPath)) {
      throw new VfsError(
        "conflict",
        `Initial file resolves to a duplicate path: ${normalizedPath}`,
      );
    }
    if (impliedDirectories.has(normalizedPath)) {
      throw new VfsError(
        "is_directory",
        `Cannot replace an initial directory with a file: ${normalizedPath}`,
      );
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    const ancestors: string[] = [];
    let ancestor = "";
    for (let index = 1; index < segments.length; index += 1) {
      ancestor += `/${segments[index - 1]}`;
      if (normalizedFiles.has(ancestor)) {
        throw new VfsError(
          "not_directory",
          `Cannot create an initial file beneath another file: ${ancestor}`,
        );
      }
      ancestors.push(ancestor);
    }
    normalizedFiles.set(normalizedPath, content);
    for (const directory of ancestors) {
      impliedDirectories.add(directory);
    }
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
