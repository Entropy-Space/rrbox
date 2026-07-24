import {
  compareVfsEntries,
  compareVfsStrings,
  isWorkspaceFilesSnapshotReader,
  normalizePath,
  VfsError,
  type VfsEntry,
  type WorkspaceFilesSnapshotReader,
  type WorkspaceReader,
} from "@researchbox/vfs";
import {
  assertWithinLimit,
  checkedAdd,
  resolveWorkspaceArchiveLimits,
} from "./limits.ts";
import {
  isWellFormedString,
  utf8ByteLengthOfWellFormedString,
  validatePortablePath,
  validatePortableWorkspaceSnapshot,
} from "./paths.ts";
import {
  WorkspaceArchiveError,
  type CapturedPortableWorkspace,
  type WorkspaceArchiveLimits,
  type WorkspaceArchiveOptions,
} from "./types.ts";

const CAPTURE_ATTEMPTS = 3;

class WorkspaceRevisionChanged extends Error {}

export async function capturePortableWorkspace(
  workspace: WorkspaceReader,
  options?: WorkspaceArchiveOptions,
  signal?: AbortSignal,
): Promise<CapturedPortableWorkspace> {
  const limits = resolveWorkspaceArchiveLimits(options);
  throwIfAborted(signal);
  if (isWorkspaceFilesSnapshotReader(workspace)) {
    return captureFilesSnapshot(workspace, limits, signal);
  }
  let observedConcurrentChange = false;

  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await captureAttempt(workspace, limits, signal);
    } catch (error) {
      if (error instanceof WorkspaceRevisionChanged) {
        observedConcurrentChange = true;
        continue;
      }
      if (observedConcurrentChange && isConcurrentShapeError(error)) continue;
      throw error;
    }
  }

  throw new WorkspaceArchiveError(
    "workspace_changed",
    `Workspace changed during all ${CAPTURE_ATTEMPTS} capture attempts.`,
  );
}

async function captureAttempt(
  workspace: WorkspaceReader,
  limits: WorkspaceArchiveLimits,
  signal: AbortSignal | undefined,
): Promise<CapturedPortableWorkspace> {
  const rootListing = await runWorkspaceRead(
    () => workspace.list("/"),
    signal,
  );
  const workspaceRevision = validateWorkspaceRevision(
    rootListing.workspace_revision,
  );
  try {
    return await captureAtRevision(
      workspace,
      rootListing.entries,
      workspaceRevision,
      limits,
      signal,
    );
  } catch (error) {
    if (!isConcurrentShapeError(error)) throw error;
    try {
      const latestRoot = await runWorkspaceRead(
        () => workspace.list("/"),
        signal,
      );
      if (
        validateWorkspaceRevision(latestRoot.workspace_revision) !==
        workspaceRevision
      ) {
        throw new WorkspaceRevisionChanged();
      }
    } catch (latestError) {
      if (
        latestError instanceof WorkspaceRevisionChanged ||
        isConcurrentShapeError(latestError)
      ) {
        throw new WorkspaceRevisionChanged();
      }
      throw latestError;
    }
    throw error;
  }
}

async function captureAtRevision(
  workspace: WorkspaceReader,
  initialRootEntries: VfsEntry[],
  workspaceRevision: number,
  limits: WorkspaceArchiveLimits,
  signal: AbortSignal | undefined,
): Promise<CapturedPortableWorkspace> {
  const rootEntries = validateListing("/", initialRootEntries, limits);
  const files: Array<{ path: string; content: string }> = [];
  const directories = ["/"];
  const seenDirectories = new Set(directories);
  let directoryIndex = 0;
  let listedContentByteSize = 0;
  const maxDirectories = deriveDirectoryLimit(limits);

  while (directoryIndex < directories.length) {
    const directory = directories[directoryIndex] ?? "/";
    directoryIndex += 1;
    const entries =
      directory === "/"
        ? rootEntries
        : validateListing(
            directory,
            assertRevision(
              await runWorkspaceRead(
                () => workspace.list(directory),
                signal,
              ),
              workspaceRevision,
            ).entries,
            limits,
          );

    for (const entry of entries) {
      if (entry.kind === "directory") {
        if (seenDirectories.has(entry.path)) {
          throw new WorkspaceArchiveError(
            "invalid_input",
            `Workspace directory appears more than once: ${entry.path}`,
          );
        }
        seenDirectories.add(entry.path);
        directories.push(entry.path);
        if (directories.length > maxDirectories) {
          throw new WorkspaceArchiveError(
            "limit_exceeded",
            "Workspace directory count exceeds the bounded traversal limit.",
          );
        }
        continue;
      }

      if (files.length >= limits.max_files) {
        throw new WorkspaceArchiveError(
          "limit_exceeded",
          `Workspace file count exceeds the configured limit (${limits.max_files}).`,
        );
      }
      assertWithinLimit(
        entry.size,
        limits.max_file_bytes,
        `Workspace file ${entry.path}`,
      );
      listedContentByteSize = checkedAdd(
        listedContentByteSize,
        entry.size,
        "Workspace content",
      );
      assertWithinLimit(
        listedContentByteSize,
        limits.max_total_content_bytes,
        "Workspace content",
      );
      const result = assertRevision(
        await runWorkspaceRead(
          () => workspace.read(entry.path),
          signal,
        ),
        workspaceRevision,
      );
      if (
        typeof result.content !== "string" ||
        !isWellFormedString(result.content)
      ) {
        throw new WorkspaceArchiveError(
          "invalid_input",
          `Workspace returned invalid Unicode content for ${entry.path}.`,
        );
      }
      const byteSize = utf8ByteLengthOfWellFormedString(result.content);
      if (entry.size !== byteSize) {
        throw new WorkspaceArchiveError(
          "invalid_input",
          `Workspace listed an incorrect byte size for ${entry.path}.`,
        );
      }
      files.push({
        path: entry.path,
        content: result.content,
      });
    }
  }

  const finalRoot = assertRevision(
    await runWorkspaceRead(
      () => workspace.list("/"),
      signal,
    ),
    workspaceRevision,
  );
  const finalRootEntries = validateListing("/", finalRoot.entries, limits);
  if (listingFingerprint(rootEntries) !== listingFingerprint(finalRootEntries)) {
    throw new WorkspaceRevisionChanged();
  }

  const validated = validatePortableWorkspaceSnapshot({ files }, limits);
  return {
    snapshot: {
      files: validated.files.map(({ path, content }) => ({ path, content })),
    },
    workspace_revision: workspaceRevision,
  };
}

async function captureFilesSnapshot(
  workspace: WorkspaceReader & WorkspaceFilesSnapshotReader,
  limits: WorkspaceArchiveLimits,
  signal: AbortSignal | undefined,
): Promise<CapturedPortableWorkspace> {
  const result = await runWorkspaceRead(
    () => workspace.readFilesSnapshot({ signal }),
    signal,
  );
  if (typeof result !== "object" || result === null) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "Workspace returned an invalid files snapshot.",
    );
  }
  const workspaceRevision = validateWorkspaceRevision(
    result.workspace_revision,
  );
  const validated = validatePortableWorkspaceSnapshot(
    { files: result.files },
    limits,
  );
  return {
    snapshot: {
      files: validated.files.map(({ path, content }) => ({ path, content })),
    },
    workspace_revision: workspaceRevision,
  };
}

async function runWorkspaceRead<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  const result = await operation();
  throwIfAborted(signal);
  return result;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ??
    new DOMException("The workspace capture was aborted.", "AbortError");
}

function assertRevision<T extends { workspace_revision: number }>(
  result: T,
  expectedRevision: number,
): T {
  const revision = validateWorkspaceRevision(result.workspace_revision);
  if (revision !== expectedRevision) {
    throw new WorkspaceRevisionChanged();
  }
  return result;
}

function validateWorkspaceRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "Workspace returned an invalid revision.",
    );
  }
  return revision;
}

function validateListing(
  directory: string,
  entries: VfsEntry[],
  limits: WorkspaceArchiveLimits,
): VfsEntry[] {
  if (!Array.isArray(entries)) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      `Workspace returned an invalid listing for ${directory}.`,
    );
  }

  const validated: VfsEntry[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();
  const prefix = directory === "/" ? "/" : `${directory}/`;

  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      typeof entry.path !== "string" ||
      (entry.kind !== "file" && entry.kind !== "directory") ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new WorkspaceArchiveError(
        "invalid_input",
        `Workspace returned an invalid entry for ${directory}.`,
      );
    }
    if (
      entry.name.length === 0 ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      entry.name.includes("\0") ||
      entry.path !== `${prefix}${entry.name}`
    ) {
      throw new WorkspaceArchiveError(
        "invalid_input",
        `Workspace returned a non-child entry for ${directory}.`,
      );
    }
    if (names.has(entry.name) || paths.has(entry.path)) {
      throw new WorkspaceArchiveError(
        "invalid_input",
        `Workspace returned a duplicate entry: ${entry.path}`,
      );
    }

    if (entry.kind === "file") {
      validatePortablePath(entry.path, limits, "invalid_input");
    } else {
      validateDirectoryPath(entry.path, limits);
      if (entry.size !== 0) {
        throw new WorkspaceArchiveError(
          "invalid_input",
          `Workspace directory has a non-zero size: ${entry.path}`,
        );
      }
    }

    names.add(entry.name);
    paths.add(entry.path);
    validated.push({ ...entry });
  }

  return validated.sort(compareVfsEntries);
}

function validateDirectoryPath(
  path: string,
  limits: WorkspaceArchiveLimits,
): void {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    !isWellFormedString(path)
  ) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      `Workspace directory path is not portable: ${JSON.stringify(path)}`,
    );
  }

  let normalized: string;
  try {
    normalized = normalizePath(path);
  } catch (error) {
    if (error instanceof VfsError) {
      throw new WorkspaceArchiveError(
        "invalid_input",
        `Workspace directory path is invalid: ${JSON.stringify(path)}`,
      );
    }
    throw error;
  }
  if (normalized !== path || path === "/") {
    throw new WorkspaceArchiveError(
      "invalid_input",
      `Workspace directory path is not canonical: ${JSON.stringify(path)}`,
    );
  }

  const bytes = new TextEncoder().encode(path).byteLength;
  if (bytes > limits.max_path_bytes) {
    throw new WorkspaceArchiveError(
      "limit_exceeded",
      `Workspace directory path exceeds the configured limit: ${path}`,
    );
  }
  if (path.split("/").length - 1 > limits.max_path_depth) {
    throw new WorkspaceArchiveError(
      "limit_exceeded",
      `Workspace directory depth exceeds the configured limit: ${path}`,
    );
  }
}

function isConcurrentShapeError(error: unknown): error is VfsError {
  if (!(error instanceof VfsError)) return false;
  switch (error.code) {
    case "not_found":
    case "is_directory":
    case "not_directory":
    case "conflict":
      return true;
    default:
      return false;
  }
}

function deriveDirectoryLimit(limits: WorkspaceArchiveLimits): number {
  const fileCapacity = Math.max(1, limits.max_files);
  if (
    limits.max_path_depth >
    Math.floor((Number.MAX_SAFE_INTEGER - 1) / fileCapacity)
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  return fileCapacity * limits.max_path_depth + 1;
}

function listingFingerprint(entries: readonly VfsEntry[]): string {
  return entries
    .slice()
    .sort((left, right) => compareVfsStrings(left.path, right.path))
    .map(
      (entry) =>
        `${entry.kind}\0${entry.name}\0${entry.path}\0${entry.size}`,
    )
    .join("\n");
}
