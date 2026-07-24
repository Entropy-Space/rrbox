import {
  WorkspaceArchiveError,
  type WorkspaceArchiveLimits,
  type WorkspaceArchiveOptions,
} from "./types.ts";

const MEBIBYTE = 1024 * 1024;

export const DEFAULT_WORKSPACE_ARCHIVE_LIMITS: Readonly<WorkspaceArchiveLimits> =
  Object.freeze({
    max_archive_bytes: 64 * MEBIBYTE,
    max_manifest_bytes: 2 * MEBIBYTE,
    max_files: 4096,
    max_file_bytes: 16 * MEBIBYTE,
    max_total_content_bytes: 64 * MEBIBYTE,
    max_path_bytes: 1024,
    max_path_depth: 128,
  });

const LIMIT_KEYS = Object.freeze(
  Object.keys(DEFAULT_WORKSPACE_ARCHIVE_LIMITS) as Array<
    keyof WorkspaceArchiveLimits
  >,
);

export function resolveWorkspaceArchiveLimits(
  options?: WorkspaceArchiveOptions,
): WorkspaceArchiveLimits {
  if (
    options !== undefined &&
    (
      typeof options !== "object" ||
      options === null ||
      Object.keys(options).some((key) => key !== "limits")
    )
  ) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "Workspace archive options must contain only the limits field.",
    );
  }
  const overrides = options?.limits;
  if (
    overrides !== undefined &&
    (typeof overrides !== "object" || overrides === null)
  ) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "Workspace archive limits must be an object.",
    );
  }
  if (
    overrides !== undefined &&
    Object.keys(overrides).some(
      (key) => !LIMIT_KEYS.includes(key as keyof WorkspaceArchiveLimits),
    )
  ) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "Workspace archive limits contain an unknown field.",
    );
  }

  const limits = { ...DEFAULT_WORKSPACE_ARCHIVE_LIMITS };
  for (const key of LIMIT_KEYS) {
    const value = overrides?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WorkspaceArchiveError(
        "invalid_input",
        `Workspace archive limit ${key} must be a non-negative safe integer.`,
      );
    }
    limits[key] = value;
  }
  return limits;
}

export function assertWithinLimit(
  value: number,
  limit: number,
  label: string,
): void {
  if (value <= limit) return;
  throw new WorkspaceArchiveError(
    "limit_exceeded",
    `${label} exceeds the configured limit (${value} > ${limit}).`,
  );
}

export function checkedAdd(
  left: number,
  right: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new WorkspaceArchiveError(
      "limit_exceeded",
      `${label} exceeds the supported integer range.`,
    );
  }
  return left + right;
}
