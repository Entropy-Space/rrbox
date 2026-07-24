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
  tool_name: "write_file" | "replace_text" | "remove_file";
  created_at: string;
};

export type WorkspaceChangeRecord = Omit<
  WorkspaceChangeMetadata,
  "assistant_message_index" | "tool_call_block_id"
> & {
  tool_call_block_id: string | null;
  legacy_message_id?: string;
  /**
   * The originating assistant message index.
   *
   * Durable adapters may canonicalize an unavailable or malformed historical
   * position to `null` only when a stable `tool_call_block_id` or
   * `legacy_message_id` is present. Stable identity always takes precedence
   * over this non-authoritative ordinal. Newly authored receipts use
   * `WorkspaceChangeMetadata` and always provide a valid index.
   */
  assistant_message_index: number | null;
  /**
   * The workspace revision that committed this receipt's file contents.
   *
   * `null` identifies a legacy receipt whose original path generation cannot
   * be proven. Such a receipt remains inspectable but must never be reverted.
   */
  applied_workspace_revision: number | null;
  /**
   * The revision that atomically consumed this receipt, or `null` while it has
   * never been reverted.
   */
  reverted_at_workspace_revision: number | null;
  path: string;
  change_kind: "created" | "updated" | "deleted";
  before_content: string | null;
  after_content: string | null;
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
  change?: WorkspaceChangeMetadata;
};

export type VfsRemoveResult = {
  path: string;
  change_kind: "deleted";
  before_content: string;
  after_content: null;
  change: WorkspaceChangeRecord;
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
  /** The workspace revision of this path's most recent mutation. */
  path_revision: number;
  content: string;
};

export type WorkspacePathStateResult =
  | {
      workspace_revision: number;
      path: string;
      kind: "file";
      path_revision: number;
      content: string;
    }
  | {
      workspace_revision: number;
      path: string;
      kind: "directory";
      path_revision: null;
    }
  | {
      workspace_revision: number;
      path: string;
      kind: "missing";
      /**
       * The last mutation revision for a path whose absence is tracked.
       *
       * `null` means the path has no authoritative deleted generation in the
       * current workspace incarnation.
       */
      path_revision: number | null;
    };

export type WorkspaceFilesSnapshotResult = {
  workspace_revision: number;
  files: VfsSeedFile[];
};

export type WorkspaceFilesSnapshotOptions = {
  signal?: AbortSignal;
};

export type WorkspaceWriteResult = {
  workspace_revision: number;
  result: VfsWriteResult;
};

export type WorkspaceRemoveResult = {
  workspace_revision: number;
  /**
   * Present only when the caller requested a journaled removal through
   * `VfsRemoveOptions.change`.
   *
   * Keeping this field absent for ordinary removals preserves the existing
   * unjournaled API while allowing an agent mutation to receive its receipt.
   */
  result?: VfsRemoveResult;
};

export type WorkspaceChangesResult = {
  workspace_revision: number;
  changes: WorkspaceChangeRecord[];
  /**
   * Present when a durable backend isolated malformed historical receipts.
   *
   * Quarantined receipts remain outside the readable/revertible journal.
   * `pending_receipt_count` identifies markers that could not yet be persisted
   * and will be retried by a later journal scan.
   */
  quarantine_status?: {
    quarantined_receipt_count: number;
    pending_receipt_count: number;
  };
};

export type WorkspaceChangeResult = {
  workspace_revision: number;
  change: WorkspaceChangeRecord | null;
};

export type WorkspaceChangeRevertResult = {
  workspace_revision: number;
  revert_outcome: "applied" | "already_reverted";
  reverted_at_workspace_revision: number;
  change: WorkspaceChangeRecord;
};

export class VfsError extends Error {
  public readonly code: VfsErrorCode;

  constructor(code: VfsErrorCode, message: string) {
    super(message);
    this.name = "VfsError";
    this.code = code;
  }
}

export class WorkspaceCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCorruptionError";
  }
}

export interface WorkspaceReader {
  list(path: string): Promise<WorkspaceListResult>;
  read(path: string): Promise<WorkspaceReadResult>;
  /**
   * Reads file content or the authoritative generation of an absent path.
   *
   * Unlike `read`, this operation does not reject a missing path. A deleted
   * receipt is current only when this returns `kind: "missing"` with the
   * receipt's exact applied revision.
   */
  getPathState(path: string): Promise<WorkspacePathStateResult>;
}

/**
 * Optional bulk-read capability for backends that can capture every file and
 * the corresponding revision in one stable operation.
 *
 * Implementations must return caller-owned file objects whose contents all
 * belong to `workspace_revision`. They must reject stale or deleted workspace
 * handles with the same `VfsError` semantics as ordinary reads.
 */
export interface WorkspaceFilesSnapshotReader {
  readFilesSnapshot(
    options?: WorkspaceFilesSnapshotOptions,
  ): Promise<WorkspaceFilesSnapshotResult>;
}

export function isWorkspaceFilesSnapshotReader(
  reader: WorkspaceReader,
): reader is WorkspaceReader & WorkspaceFilesSnapshotReader {
  return (
    typeof (reader as Partial<WorkspaceFilesSnapshotReader>)
      .readFilesSnapshot === "function"
  );
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
  /**
   * Returns one change and the workspace revision observed by the same
   * operation. A missing identifier returns `change: null`.
   *
   * A returned record is caller-owned and may be mutated without affecting
   * later journal reads. Once committed, every receipt field is immutable
   * except `reverted_at_workspace_revision`, which may transition exactly once
   * from `null` to the revision of its successful revert.
   */
  getChange(changeId: string): Promise<WorkspaceChangeResult>;
  /**
   * Atomically reverts and consumes one change receipt.
   *
   * A missing receipt rejects with `VfsError` code `not_found`. An unconsumed
   * receipt is revertible only while its path is still the exact file
   * generation and content committed by the receipt. Any later mutation of
   * that path, including an edit-away/edit-back ABA cycle, rejects with
   * `conflict`. A successful first call restores `before_content` (or removes a
   * created file), marks the receipt consumed, and increments the workspace
   * revision exactly once. Later calls return `already_reverted` without
   * mutating the workspace, even if the path has subsequently changed.
   */
  revertChange(changeId: string): Promise<WorkspaceChangeRevertResult>;
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
 * not optional backend capabilities. New receipts must carry their non-null
 * `applied_workspace_revision`, and every successful read must return the
 * path's last mutation revision from the same observation as its content.
 * Removed paths retain a generation tombstone so `getPathState` can
 * distinguish the original absence from a delete/recreate/delete ABA cycle.
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
  if (change?.tool_name === "remove_file") {
    throw new VfsError(
      "conflict",
      "A remove_file receipt cannot journal a file write.",
    );
  }
  if (change?.tool_name === "replace_text" && beforeContent === null) {
    throw new VfsError(
      "conflict",
      "A replace_text receipt cannot journal a file creation.",
    );
  }
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
            applied_workspace_revision: null,
            reverted_at_workspace_revision: null,
            path: normalizedPath,
            change_kind: changeKind,
            before_content: beforeContent,
            after_content: afterContent,
            ...computeLineChanges(beforeContent ?? "", afterContent),
            byte_size: new TextEncoder().encode(afterContent).byteLength,
          },
  };
}

/**
 * Stamps a journaled write with the revision that atomically committed it.
 */
export function applyWorkspaceChangeRevision(
  result: VfsWriteResult,
  workspaceRevision: number,
): VfsWriteResult {
  if (result.change === null) return result;
  return {
    ...result,
    change: applyWorkspaceChangeRecordRevision(
      result.change,
      workspaceRevision,
    ),
  };
}

/**
 * Creates the immutable before/after receipt for a removed UTF-8 file.
 */
export function createVfsRemoveResult(
  path: string,
  beforeContent: string,
  change: WorkspaceChangeMetadata,
): VfsRemoveResult {
  const normalizedPath = normalizeFilePath(path);
  if (change.tool_name !== "remove_file") {
    throw new VfsError(
      "conflict",
      "A file removal requires a remove_file receipt.",
    );
  }
  const record: WorkspaceChangeRecord = {
    ...change,
    applied_workspace_revision: null,
    reverted_at_workspace_revision: null,
    path: normalizedPath,
    change_kind: "deleted",
    before_content: beforeContent,
    after_content: null,
    ...computeLineChanges(beforeContent, ""),
    byte_size: 0,
  };
  return {
    path: normalizedPath,
    change_kind: "deleted",
    before_content: beforeContent,
    after_content: null,
    change: record,
  };
}

export function applyWorkspaceRemoveChangeRevision(
  result: VfsRemoveResult,
  workspaceRevision: number,
): VfsRemoveResult {
  return {
    ...result,
    change: applyWorkspaceChangeRecordRevision(
      result.change,
      workspaceRevision,
    ),
  };
}

/**
 * Stamps any journaled workspace mutation with its atomic commit revision.
 */
export function applyWorkspaceChangeRecordRevision(
  change: WorkspaceChangeRecord,
  workspaceRevision: number,
): WorkspaceChangeRecord {
  if (!Number.isSafeInteger(workspaceRevision) || workspaceRevision < 0) {
    throw new VfsError("conflict", "Workspace revision is invalid.");
  }
  return {
    ...change,
    applied_workspace_revision: workspaceRevision,
    reverted_at_workspace_revision: null,
  };
}

/**
 * Rejects a malformed or temporally impossible workspace change receipt.
 *
 * Durable adapters must call this before trusting persisted receipt fields for
 * a destructive operation. `applied_workspace_revision: null` remains valid
 * for legacy, inspectable receipts, but such a receipt is not revertible.
 */
export function assertValidWorkspaceChangeRecord(
  value: unknown,
  workspaceRevision?: number,
): asserts value is WorkspaceChangeRecord {
  if (typeof value !== "object" || value === null) {
    throw invalidWorkspaceChangeRecord("is not an object");
  }
  if (
    workspaceRevision !== undefined &&
    (!Number.isSafeInteger(workspaceRevision) || workspaceRevision < 0)
  ) {
    throw invalidWorkspaceChangeRecord(
      "was checked against an invalid workspace revision",
    );
  }

  const change = value as Partial<
    Record<keyof WorkspaceChangeRecord, unknown>
  >;
  for (const [field, candidate] of [
    ["change_id", change.change_id],
    ["session_id", change.session_id],
    ["tool_call_id", change.tool_call_id],
  ] as const) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw invalidWorkspaceChangeRecord(
        `has an invalid ${field}`,
      );
    }
  }
  if (
    change.tool_call_block_id !== null &&
    (typeof change.tool_call_block_id !== "string" ||
      change.tool_call_block_id.length === 0)
  ) {
    throw invalidWorkspaceChangeRecord(
      "has an invalid tool_call_block_id",
    );
  }
  if (
    change.legacy_message_id !== undefined &&
    (typeof change.legacy_message_id !== "string" ||
      change.legacy_message_id.length === 0)
  ) {
    throw invalidWorkspaceChangeRecord(
      "has an invalid legacy_message_id",
    );
  }
  const hasStableAssistantMessageIdentity =
    typeof change.tool_call_block_id === "string" ||
    typeof change.legacy_message_id === "string";
  if (
    change.assistant_message_index === null &&
    !hasStableAssistantMessageIdentity
  ) {
    throw invalidWorkspaceChangeRecord(
      "has no stable assistant message identity",
    );
  }
  if (
    change.assistant_message_index !== null &&
    (!Number.isSafeInteger(change.assistant_message_index) ||
      (change.assistant_message_index as number) < 0)
  ) {
    throw invalidWorkspaceChangeRecord(
      "has an invalid assistant_message_index",
    );
  }
  if (
    change.tool_name !== "write_file" &&
    change.tool_name !== "replace_text" &&
    change.tool_name !== "remove_file"
  ) {
    throw invalidWorkspaceChangeRecord("has an invalid tool_name");
  }
  if (
    typeof change.created_at !== "string" ||
    canonicalWorkspaceChangeTimestamp(change.created_at) !==
      change.created_at
  ) {
    throw invalidWorkspaceChangeRecord("has an invalid created_at");
  }

  const appliedRevision = change.applied_workspace_revision;
  const revertedRevision = change.reverted_at_workspace_revision;
  if (
    appliedRevision !== null &&
    (!Number.isSafeInteger(appliedRevision) ||
      (appliedRevision as number) < 1)
  ) {
    throw invalidWorkspaceChangeRecord(
      "has an invalid applied_workspace_revision",
    );
  }
  if (
    revertedRevision !== null &&
    (!Number.isSafeInteger(revertedRevision) ||
      (revertedRevision as number) < 1)
  ) {
    throw invalidWorkspaceChangeRecord(
      "has an invalid reverted_at_workspace_revision",
    );
  }
  if (
    workspaceRevision !== undefined &&
    ((typeof appliedRevision === "number" &&
      appliedRevision > workspaceRevision) ||
      (typeof revertedRevision === "number" &&
        revertedRevision > workspaceRevision))
  ) {
    throw invalidWorkspaceChangeRecord(
      "contains a revision from the future",
    );
  }
  if (
    revertedRevision !== null &&
    (appliedRevision === null ||
      typeof appliedRevision !== "number" ||
      typeof revertedRevision !== "number" ||
      revertedRevision <= appliedRevision)
  ) {
    throw invalidWorkspaceChangeRecord(
      "has an invalid revert disposition",
    );
  }

  if (typeof change.path !== "string") {
    throw invalidWorkspaceChangeRecord("has an invalid path");
  }
  let normalizedPath: string;
  try {
    normalizedPath = normalizeFilePath(change.path);
  } catch {
    throw invalidWorkspaceChangeRecord("has an invalid path");
  }
  if (normalizedPath !== change.path) {
    throw invalidWorkspaceChangeRecord("has a non-canonical path");
  }
  if (
    change.change_kind !== "created" &&
    change.change_kind !== "updated" &&
    change.change_kind !== "deleted"
  ) {
    throw invalidWorkspaceChangeRecord("has an invalid change_kind");
  }
  const toolMatchesChangeKind =
    (change.tool_name === "write_file" &&
      (change.change_kind === "created" ||
        change.change_kind === "updated")) ||
    (change.tool_name === "replace_text" &&
      change.change_kind === "updated") ||
    (change.tool_name === "remove_file" &&
      change.change_kind === "deleted");
  if (!toolMatchesChangeKind) {
    throw invalidWorkspaceChangeRecord(
      "has a tool_name inconsistent with its change_kind",
    );
  }
  if (
    change.after_content !== null &&
    typeof change.after_content !== "string"
  ) {
    throw invalidWorkspaceChangeRecord(
      "has invalid after_content",
    );
  }
  if (
    (change.change_kind === "created" &&
      (change.before_content !== null ||
        typeof change.after_content !== "string")) ||
    (change.change_kind === "updated" &&
      (typeof change.before_content !== "string" ||
        typeof change.after_content !== "string")) ||
    (change.change_kind === "deleted" &&
      (typeof change.before_content !== "string" ||
        change.after_content !== null))
  ) {
    throw invalidWorkspaceChangeRecord(
      "has inconsistent change content",
    );
  }
  if (change.before_content === change.after_content) {
    throw invalidWorkspaceChangeRecord(
      "does not describe a content change",
    );
  }

  const beforeContent = change.before_content as string | null;
  const afterContent = change.after_content as string | null;
  const lineChanges = computeLineChanges(
    beforeContent ?? "",
    afterContent ?? "",
  );
  if (
    !Number.isSafeInteger(change.additions) ||
    (change.additions as number) < 0 ||
    change.additions !== lineChanges.additions ||
    !Number.isSafeInteger(change.deletions) ||
    (change.deletions as number) < 0 ||
    change.deletions !== lineChanges.deletions
  ) {
    throw invalidWorkspaceChangeRecord(
      "has invalid line change counts",
    );
  }
  if (
    !Number.isSafeInteger(change.byte_size) ||
    (change.byte_size as number) < 0 ||
    change.byte_size !==
      new TextEncoder().encode(afterContent ?? "").byteLength
  ) {
    throw invalidWorkspaceChangeRecord("has an invalid byte_size");
  }
}

/**
 * Normalizes optional revision fields from durable legacy records.
 */
export function normalizeStoredWorkspaceRevision(
  value: unknown,
): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function canonicalWorkspaceChangeTimestamp(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return null;
  }
}

function invalidWorkspaceChangeRecord(
  detail: string,
): WorkspaceCorruptionError {
  return new WorkspaceCorruptionError(
    `Workspace change receipt ${detail}.`,
  );
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
