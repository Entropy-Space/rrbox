import type { VfsSeedFile } from "@researchbox/vfs";

export const WORKSPACE_ARCHIVE_FORMAT_VERSION = 1 as const;
export const WORKSPACE_ARCHIVE_MANIFEST_PATH =
  "researchbox-workspace.json" as const;

export type PortableWorkspaceSnapshot = {
  files: VfsSeedFile[];
};

export type CapturedPortableWorkspace = {
  snapshot: PortableWorkspaceSnapshot;
  workspace_revision: number;
};

export type WorkspaceArchiveLimits = {
  max_archive_bytes: number;
  max_manifest_bytes: number;
  max_files: number;
  max_file_bytes: number;
  max_total_content_bytes: number;
  max_path_bytes: number;
  max_path_depth: number;
};

export type WorkspaceArchiveOptions = {
  limits?: Partial<WorkspaceArchiveLimits>;
};

export type WorkspaceArchiveExportResult = {
  archive_bytes: Uint8Array;
  workspace_revision: number;
  file_count: number;
  content_byte_size: number;
};

export type WorkspaceArchiveErrorCode =
  | "invalid_input"
  | "invalid_archive"
  | "unsupported_format"
  | "limit_exceeded"
  | "workspace_changed";

export class WorkspaceArchiveError extends Error {
  public readonly code: WorkspaceArchiveErrorCode;

  constructor(code: WorkspaceArchiveErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceArchiveError";
    this.code = code;
  }
}

export type WorkspaceArchiveManifestFile = {
  path: string;
  archive_path: string;
  byte_size: number;
  sha256: string;
};

export type WorkspaceArchiveManifestV1 = {
  format: "researchbox_workspace";
  format_version: typeof WORKSPACE_ARCHIVE_FORMAT_VERSION;
  content_encoding: "utf-8";
  files: WorkspaceArchiveManifestFile[];
};
