import {
  compareVfsStrings,
  type VfsSeedFile,
  type WorkspaceReader,
} from "@researchbox/vfs";
import { zipSync, type ZipOptions, type Zippable } from "fflate";
import { capturePortableWorkspace } from "./capture.ts";
import { sha256Hex } from "./integrity.ts";
import {
  assertWithinLimit,
  checkedAdd,
  resolveWorkspaceArchiveLimits,
} from "./limits.ts";
import {
  assertNoPathCollisions,
  assertSafeZipEntryName,
  hasExactKeys,
  isRecord,
  toWorkspaceArchivePath,
  validatePortablePath,
  validatePortableWorkspaceSnapshot,
} from "./paths.ts";
import {
  WORKSPACE_ARCHIVE_FORMAT_VERSION,
  WORKSPACE_ARCHIVE_MANIFEST_PATH,
  WorkspaceArchiveError,
  type PortableWorkspaceSnapshot,
  type WorkspaceArchiveExportResult,
  type WorkspaceArchiveLimits,
  type WorkspaceArchiveManifestFile,
  type WorkspaceArchiveManifestV1,
  type WorkspaceArchiveOptions,
} from "./types.ts";
import {
  auditWorkspaceZip,
  extractAuditedZipEntry,
} from "./zip.ts";
import { canonicalZipByteSize } from "./zip-layout.ts";

const textEncoder = new TextEncoder();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ZIP_OPTIONS: Readonly<ZipOptions> = Object.freeze({
  level: 0,
  os: 0,
  attrs: 0,
  mtime: new Date(1980, 0, 1, 0, 0, 0, 0),
});

export function encodeWorkspaceArchive(
  snapshot: PortableWorkspaceSnapshot,
  options?: WorkspaceArchiveOptions,
): Uint8Array {
  const limits = resolveWorkspaceArchiveLimits(options);
  const validated = validatePortableWorkspaceSnapshot(snapshot, limits);
  const manifest: WorkspaceArchiveManifestV1 = {
    format: "researchbox_workspace",
    format_version: WORKSPACE_ARCHIVE_FORMAT_VERSION,
    content_encoding: "utf-8",
    files: validated.files.map((file) => ({
      path: file.path,
      archive_path: file.archive_path,
      byte_size: file.bytes.byteLength,
      sha256: sha256Hex(file.bytes),
    })),
  };
  const manifestBytes = textEncoder.encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  assertWithinLimit(
    manifestBytes.byteLength,
    limits.max_manifest_bytes,
    "Workspace archive manifest",
  );
  const expectedArchiveSize = canonicalArchiveByteSize(
    manifestBytes,
    validated.files,
  );
  assertWithinLimit(
    expectedArchiveSize,
    limits.max_archive_bytes,
    "Workspace archive",
  );

  const entries: Zippable = {
    [WORKSPACE_ARCHIVE_MANIFEST_PATH]: [manifestBytes, ZIP_OPTIONS],
  };
  for (const file of validated.files) {
    entries[file.archive_path] = [file.bytes, ZIP_OPTIONS];
  }

  let archiveBytes: Uint8Array;
  try {
    archiveBytes = zipSync(entries, ZIP_OPTIONS);
  } catch (error) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      `Could not encode the workspace archive: ${errorMessage(error)}`,
    );
  }
  assertWithinLimit(
    archiveBytes.byteLength,
    limits.max_archive_bytes,
    "Workspace archive",
  );
  if (archiveBytes.byteLength !== expectedArchiveSize) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "The ZIP encoder produced a noncanonical workspace archive layout.",
    );
  }
  return archiveBytes;
}

export async function exportWorkspaceArchive(
  workspace: WorkspaceReader,
  options?: WorkspaceArchiveOptions,
): Promise<WorkspaceArchiveExportResult> {
  const captured = await capturePortableWorkspace(workspace, options);
  const limits = resolveWorkspaceArchiveLimits(options);
  const validated = validatePortableWorkspaceSnapshot(
    captured.snapshot,
    limits,
  );
  return {
    archive_bytes: encodeWorkspaceArchive(captured.snapshot, options),
    workspace_revision: captured.workspace_revision,
    file_count: validated.files.length,
    content_byte_size: validated.content_byte_size,
  };
}

export function decodeWorkspaceArchive(
  archiveBytes: Uint8Array | ArrayBuffer,
  options?: WorkspaceArchiveOptions,
): PortableWorkspaceSnapshot {
  const limits = resolveWorkspaceArchiveLimits(options);
  const bytes = normalizeArchiveBytes(archiveBytes);
  const entries = auditWorkspaceZip(bytes, limits);
  const manifestEntry = entries[0];
  if (!manifestEntry) {
    throw new WorkspaceArchiveError(
      "invalid_archive",
      "Workspace archive contains no manifest.",
    );
  }
  const manifestBytes = extractAuditedZipEntry(bytes, manifestEntry);
  const manifest = parseManifest(manifestBytes, limits);
  if (entries.length !== manifest.files.length + 1) {
    throw new WorkspaceArchiveError(
      "invalid_archive",
      "Workspace archive entries do not match its manifest.",
    );
  }

  const entriesByName = new Map(
    entries.slice(1).map((entry) => [entry.name, entry]),
  );
  const files: VfsSeedFile[] = [];
  for (const manifestFile of manifest.files) {
    const entry = entriesByName.get(manifestFile.archive_path);
    if (!entry) {
      throw new WorkspaceArchiveError(
        "invalid_archive",
        `Workspace archive is missing ${manifestFile.archive_path}.`,
      );
    }
    if (entry.uncompressed_size !== manifestFile.byte_size) {
      throw new WorkspaceArchiveError(
        "invalid_archive",
        `Workspace archive size does not match its manifest: ${manifestFile.path}`,
      );
    }

    const contentBytes = extractAuditedZipEntry(bytes, entry);
    if (sha256Hex(contentBytes) !== manifestFile.sha256) {
      throw new WorkspaceArchiveError(
        "invalid_archive",
        `Workspace archive hash does not match its manifest: ${manifestFile.path}`,
      );
    }
    files.push({
      path: manifestFile.path,
      content: decodeUtf8(
        contentBytes,
        `Workspace file is not valid UTF-8: ${manifestFile.path}`,
      ),
    });
  }

  files.sort((left, right) => compareVfsStrings(left.path, right.path));
  return { files };
}

function normalizeArchiveBytes(
  archiveBytes: Uint8Array | ArrayBuffer,
): Uint8Array {
  if (archiveBytes instanceof Uint8Array) return archiveBytes;
  if (archiveBytes instanceof ArrayBuffer) return new Uint8Array(archiveBytes);
  throw new WorkspaceArchiveError(
    "invalid_input",
    "Workspace archive bytes must be a Uint8Array or ArrayBuffer.",
  );
}

function parseManifest(
  bytes: Uint8Array,
  limits: WorkspaceArchiveLimits,
): WorkspaceArchiveManifestV1 {
  assertWithinLimit(
    bytes.byteLength,
    limits.max_manifest_bytes,
    "Workspace archive manifest",
  );
  if (
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new WorkspaceArchiveError(
      "invalid_archive",
      "Workspace archive manifest must not contain a UTF-8 byte-order mark.",
    );
  }

  let parsed: unknown;
  const source = decodeUtf8(
    bytes,
    "Workspace archive manifest is not valid UTF-8.",
  );
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    if (error instanceof WorkspaceArchiveError) throw error;
    throw new WorkspaceArchiveError(
      "invalid_archive",
      `Workspace archive manifest is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "format",
      "format_version",
      "content_encoding",
      "files",
    ])
  ) {
    throw new WorkspaceArchiveError(
      "invalid_archive",
      "Workspace archive manifest has an invalid schema.",
    );
  }
  if (
    parsed.format !== "researchbox_workspace" ||
    parsed.format_version !== WORKSPACE_ARCHIVE_FORMAT_VERSION ||
    parsed.content_encoding !== "utf-8"
  ) {
    throw new WorkspaceArchiveError(
      "unsupported_format",
      "Workspace archive format, version, or content encoding is unsupported.",
    );
  }
  if (!Array.isArray(parsed.files)) {
    throw new WorkspaceArchiveError(
      "invalid_archive",
      "Workspace archive manifest files field must be an array.",
    );
  }
  assertWithinLimit(
    parsed.files.length,
    limits.max_files,
    "Workspace archive file count",
  );

  const files: WorkspaceArchiveManifestFile[] = [];
  const paths = new Set<string>();
  const archivePaths = new Set<string>();
  let contentByteSize = 0;

  for (const candidate of parsed.files) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "path",
        "archive_path",
        "byte_size",
        "sha256",
      ]) ||
      typeof candidate.path !== "string" ||
      typeof candidate.archive_path !== "string" ||
      !Number.isSafeInteger(candidate.byte_size) ||
      (candidate.byte_size as number) < 0 ||
      typeof candidate.sha256 !== "string"
    ) {
      throw new WorkspaceArchiveError(
        "invalid_archive",
        "Workspace archive manifest contains an invalid file record.",
      );
    }

    const path = validatePortablePath(
      candidate.path,
      limits,
      "invalid_archive",
    );
    const archivePath = candidate.archive_path;
    assertSafeZipEntryName(archivePath);
    if (archivePath !== toWorkspaceArchivePath(path)) {
      throw new WorkspaceArchiveError(
        "invalid_archive",
        `Workspace archive path does not match its logical path: ${path}`,
      );
    }
    if (!SHA256_PATTERN.test(candidate.sha256)) {
      throw new WorkspaceArchiveError(
        "invalid_archive",
        `Workspace archive contains an invalid SHA-256 value: ${path}`,
      );
    }
    if (paths.has(path) || archivePaths.has(archivePath)) {
      throw new WorkspaceArchiveError(
        "invalid_archive",
        `Workspace archive manifest contains a duplicate path: ${path}`,
      );
    }

    const byteSize = candidate.byte_size as number;
    assertWithinLimit(
      byteSize,
      limits.max_file_bytes,
      `Workspace archive file ${path}`,
    );
    contentByteSize = checkedAdd(
      contentByteSize,
      byteSize,
      "Workspace archive content",
    );
    assertWithinLimit(
      contentByteSize,
      limits.max_total_content_bytes,
      "Workspace archive content",
    );

    paths.add(path);
    archivePaths.add(archivePath);
    files.push({
      path,
      archive_path: archivePath,
      byte_size: byteSize,
      sha256: candidate.sha256,
    });
  }

  assertNoPathCollisions(paths, "invalid_archive");
  const manifest: WorkspaceArchiveManifestV1 = {
    format: "researchbox_workspace",
    format_version: WORKSPACE_ARCHIVE_FORMAT_VERSION,
    content_encoding: "utf-8",
    files: files
      .slice()
      .sort((left, right) => compareVfsStrings(left.path, right.path)),
  };
  const canonicalSource = `${JSON.stringify(manifest, null, 2)}\n`;
  if (source !== canonicalSource) {
    throw new WorkspaceArchiveError(
      "invalid_archive",
      "Workspace archive manifest is not in canonical v1 form.",
    );
  }
  return manifest;
}

function decodeUtf8(bytes: Uint8Array, message: string): string {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new WorkspaceArchiveError("invalid_archive", message);
  }
}

function canonicalArchiveByteSize(
  manifestBytes: Uint8Array,
  files: ReadonlyArray<{
    archive_path: string;
    bytes: Uint8Array;
  }>,
): number {
  return canonicalZipByteSize([
    {
      name_byte_size: textEncoder.encode(WORKSPACE_ARCHIVE_MANIFEST_PATH)
        .byteLength,
      content_byte_size: manifestBytes.byteLength,
    },
    ...files.map((file) => ({
      name_byte_size: textEncoder.encode(file.archive_path).byteLength,
      content_byte_size: file.bytes.byteLength,
    })),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
