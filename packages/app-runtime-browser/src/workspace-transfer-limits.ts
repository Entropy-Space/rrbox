import type {
  WorkspaceArchiveLimits,
  WorkspaceArchiveOptions,
} from "@researchbox/workspace-archive/limits";

const MEBIBYTE = 1024 * 1024;

/**
 * Browser transfers cross three isolated realms as JSON strings. Keep their
 * ceiling below the portable codec default so WebKit does not need to retain
 * several hundred MiB of transient structured-clone and UTF-8 buffers.
 */
export const BROWSER_WORKSPACE_ARCHIVE_LIMITS: Readonly<WorkspaceArchiveLimits> =
  Object.freeze({
    max_archive_bytes: 16 * MEBIBYTE,
    max_manifest_bytes: 1 * MEBIBYTE,
    max_files: 2048,
    max_file_bytes: 8 * MEBIBYTE,
    max_total_content_bytes: 16 * MEBIBYTE,
    max_path_bytes: 1024,
    max_path_depth: 64,
  });

export const BROWSER_WORKSPACE_ARCHIVE_OPTIONS: WorkspaceArchiveOptions =
  Object.freeze({
    limits: BROWSER_WORKSPACE_ARCHIVE_LIMITS,
  });
