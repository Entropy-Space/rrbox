import {
  compareVfsStrings,
  normalizePath,
  VfsError,
  type WorkspaceReader,
} from "@researchbox/vfs";
import {
  capturePortableWorkspace,
  type WorkspaceArchiveOptions,
} from "@researchbox/workspace-archive/snapshot";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_MAX_MATCHES = 100;
const MAX_MAX_MATCHES = 1_000;
const DEFAULT_MAX_PREVIEW_CODE_POINTS = 240;
const MAX_MAX_PREVIEW_CODE_POINTS = 4_096;
const MAX_QUERY_CODE_POINTS = 4_096;
const ABORT_CHECK_INTERVAL = 4_096;
const EVENT_LOOP_YIELD_INTERVAL = 256 * 1024;

const SEARCH_CAPTURE_OPTIONS = Object.freeze({
  limits: Object.freeze({
    max_archive_bytes: 8 * MEBIBYTE,
    max_manifest_bytes: 256 * 1024,
    max_files: 1_024,
    max_file_bytes: 2 * MEBIBYTE,
    max_total_content_bytes: 8 * MEBIBYTE,
    max_path_bytes: 1_024,
    max_path_depth: 64,
  }),
}) satisfies WorkspaceArchiveOptions;

export type WorkspaceTextSearchInput = {
  path: string;
  query: string;
  /**
   * Internal output bound. This is not intended to be exposed as a model tool
   * argument.
   */
  max_matches?: number;
  /**
   * Internal nominal preview bound. A longer query is always preserved in
   * full, so its matching preview may exceed this number of code points.
   */
  max_preview_code_points?: number;
};

export type WorkspaceTextSearchMatch = {
  path: string;
  line_number: number;
  column_number: number;
  preview: string;
};

export type WorkspaceTextSearchResult = {
  workspace_revision: number;
  path: string;
  query: string;
  matches: WorkspaceTextSearchMatch[];
  files_scanned: number;
  truncated: boolean;
};

type ResolvedWorkspaceTextSearchInput = {
  path: string;
  query: string;
  query_code_point_length: number;
  max_matches: number;
  max_preview_code_points: number;
};

type SearchProgress = {
  code_units_since_yield: number;
};

/**
 * Searches one file or an implicit workspace directory using a coherent,
 * bounded portable snapshot.
 *
 * Matching is case-sensitive and literal. At most one result is returned for
 * each matching line, using the first occurrence on that line.
 */
export async function searchWorkspaceText(
  workspace: WorkspaceReader,
  input: WorkspaceTextSearchInput,
  signal?: AbortSignal,
): Promise<WorkspaceTextSearchResult> {
  throwIfAborted(signal);
  const resolved = resolveSearchInput(input);
  const captured = await capturePortableWorkspace(
    workspace,
    SEARCH_CAPTURE_OPTIONS,
    signal,
  );
  throwIfAborted(signal);

  const files = selectFiles(
    captured.snapshot.files,
    resolved.path,
  );
  const matches: WorkspaceTextSearchMatch[] = [];
  let filesScanned = 0;
  const searchProgress: SearchProgress = {
    code_units_since_yield: 0,
  };

  for (const file of files) {
    throwIfAborted(signal);
    filesScanned += 1;
    const truncated = await scanFile(
      file,
      resolved,
      matches,
      searchProgress,
      signal,
    );
    if (truncated) {
      return {
        workspace_revision: captured.workspace_revision,
        path: resolved.path,
        query: resolved.query,
        matches,
        files_scanned: filesScanned,
        truncated: true,
      };
    }
  }

  throwIfAborted(signal);
  return {
    workspace_revision: captured.workspace_revision,
    path: resolved.path,
    query: resolved.query,
    matches,
    files_scanned: filesScanned,
    truncated: false,
  };
}

function resolveSearchInput(
  input: WorkspaceTextSearchInput,
): ResolvedWorkspaceTextSearchInput {
  if (!isRecord(input)) {
    throw new TypeError("Workspace search input must be an object.");
  }
  const allowedKeys = new Set([
    "path",
    "query",
    "max_matches",
    "max_preview_code_points",
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new TypeError("Workspace search input contains an unknown field.");
  }
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new TypeError("Workspace search path must be a non-empty string.");
  }
  if (
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    !isWellFormedString(input.query) ||
    containsLineTerminator(input.query)
  ) {
    throw new TypeError(
      "Workspace search query must be a non-empty, single-line Unicode string.",
    );
  }
  const queryCodePointLength = countCodePoints(input.query);
  if (queryCodePointLength > MAX_QUERY_CODE_POINTS) {
    throw new RangeError(
      `Workspace search query must contain at most ${MAX_QUERY_CODE_POINTS} code points.`,
    );
  }

  return {
    path: normalizePath(input.path),
    query: input.query,
    query_code_point_length: queryCodePointLength,
    max_matches: readBoundedPositiveInteger(
      input.max_matches,
      DEFAULT_MAX_MATCHES,
      MAX_MAX_MATCHES,
      "max_matches",
    ),
    max_preview_code_points: readBoundedPositiveInteger(
      input.max_preview_code_points,
      DEFAULT_MAX_PREVIEW_CODE_POINTS,
      MAX_MAX_PREVIEW_CODE_POINTS,
      "max_preview_code_points",
    ),
  };
}

function selectFiles(
  files: readonly Readonly<{ path: string; content: string }>[],
  path: string,
): Array<{ path: string; content: string }> {
  const exactFile = files.find((file) => file.path === path);
  if (exactFile) {
    return [{
      path: exactFile.path,
      content: exactFile.content,
    }];
  }

  const prefix = path === "/" ? "/" : `${path}/`;
  const selected = files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({
      path: file.path,
      content: file.content,
    }))
    .sort((left, right) => compareVfsStrings(left.path, right.path));
  if (path !== "/" && selected.length === 0) {
    throw new VfsError("not_found", `Workspace path not found: ${path}`);
  }
  return selected;
}

async function scanFile(
  file: Readonly<{ path: string; content: string }>,
  input: ResolvedWorkspaceTextSearchInput,
  matches: WorkspaceTextSearchMatch[],
  progress: SearchProgress,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const { content } = file;
  let lineStart = 0;
  let lineNumber = 1;

  for (let index = 0; index < content.length; index += 1) {
    if (index % ABORT_CHECK_INTERVAL === 0) throwIfAborted(signal);
    progress.code_units_since_yield += 1;
    if (progress.code_units_since_yield >= EVENT_LOOP_YIELD_INTERVAL) {
      progress.code_units_since_yield = 0;
      await yieldToEventLoop(signal);
    }
    const codeUnit = content.charCodeAt(index);
    if (
      codeUnit !== 0x0a &&
      codeUnit !== 0x0d &&
      codeUnit !== 0x2028 &&
      codeUnit !== 0x2029
    ) {
      continue;
    }

    if (
      recordSearchLine(
        file.path,
        content.slice(lineStart, index),
        lineNumber,
        input,
        matches,
      )
    ) {
      return true;
    }
    if (
      codeUnit === 0x0d &&
      content.charCodeAt(index + 1) === 0x0a
    ) {
      index += 1;
      progress.code_units_since_yield += 1;
    }
    lineStart = index + 1;
    lineNumber += 1;
  }

  throwIfAborted(signal);
  return recordSearchLine(
    file.path,
    content.slice(lineStart),
    lineNumber,
    input,
    matches,
  );
}

function recordSearchLine(
  path: string,
  line: string,
  lineNumber: number,
  input: ResolvedWorkspaceTextSearchInput,
  matches: WorkspaceTextSearchMatch[],
): boolean {
  const matchIndex = line.indexOf(input.query);
  if (matchIndex === -1) return false;
  if (matches.length >= input.max_matches) return true;

  matches.push({
    path,
    line_number: lineNumber,
    column_number: countCodePoints(line, 0, matchIndex) + 1,
    preview: createMatchPreview(
      line,
      matchIndex,
      input.query_code_point_length,
      input.max_preview_code_points,
    ),
  });
  return false;
}

function createMatchPreview(
  line: string,
  matchCodeUnitIndex: number,
  queryLength: number,
  nominalLimit: number,
): string {
  const lineCodePoints = Array.from(line);
  const matchStart = countCodePoints(line, 0, matchCodeUnitIndex);
  const previewLength = Math.max(nominalLimit, queryLength);
  if (lineCodePoints.length <= previewLength) return line;

  const contextLength = previewLength - queryLength;
  let previewStart = Math.max(
    0,
    matchStart - Math.floor(contextLength / 2),
  );
  let previewEnd = previewStart + previewLength;
  if (previewEnd > lineCodePoints.length) {
    previewEnd = lineCodePoints.length;
    previewStart = previewEnd - previewLength;
  }
  return lineCodePoints.slice(previewStart, previewEnd).join("");
}

function countCodePoints(
  value: string,
  start = 0,
  end = value.length,
): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < end
    ) {
      index += 1;
    }
    count += 1;
  }
  return count;
}

function containsLineTerminator(value: string): boolean {
  return (
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\u2028") ||
    value.includes("\u2029")
  );
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue;
    if (codeUnit > 0xdbff) return false;
    const nextCodeUnit = value.charCodeAt(index + 1);
    if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
    index += 1;
  }
  return true;
}

function readBoundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    throw new RangeError(
      `${name} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return resolved;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ??
    new DOMException("The workspace search was aborted.", "AbortError");
}

async function yieldToEventLoop(
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
