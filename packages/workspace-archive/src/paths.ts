import {
  compareVfsStrings,
  normalizeFilePath,
  VfsError,
  type VfsSeedFile,
} from "@researchbox/vfs";
import { assertWithinLimit, checkedAdd } from "./limits.ts";
import {
  WorkspaceArchiveError,
  type PortableWorkspaceSnapshot,
  type WorkspaceArchiveLimits,
} from "./types.ts";

const textEncoder = new TextEncoder();

export type ValidatedPortableFile = VfsSeedFile & {
  archive_path: string;
  bytes: Uint8Array;
};

export type ValidatedPortableSnapshot = {
  files: ValidatedPortableFile[];
  content_byte_size: number;
};

export function validatePortableWorkspaceSnapshot(
  snapshot: PortableWorkspaceSnapshot,
  limits: WorkspaceArchiveLimits,
): ValidatedPortableSnapshot {
  if (!isRecord(snapshot) || !hasExactKeys(snapshot, ["files"])) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "A portable workspace snapshot must contain exactly one files array.",
    );
  }
  if (!Array.isArray(snapshot.files)) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "A portable workspace snapshot must contain a files array.",
    );
  }
  assertWithinLimit(
    snapshot.files.length,
    limits.max_files,
    "Workspace file count",
  );

  const paths = new Set<string>();
  const files: ValidatedPortableFile[] = [];
  let contentByteSize = 0;

  for (const candidate of snapshot.files) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["path", "content"]) ||
      typeof candidate.path !== "string" ||
      typeof candidate.content !== "string"
    ) {
      throw new WorkspaceArchiveError(
        "invalid_input",
        "Every portable workspace file must contain string path and content fields.",
      );
    }

    const path = validatePortablePath(candidate.path, limits, "invalid_input");
    if (paths.has(path)) {
      throw new WorkspaceArchiveError(
        "invalid_input",
        `Portable workspace contains a duplicate path: ${path}`,
      );
    }
    assertWellFormedString(candidate.content, `File content is not valid Unicode: ${path}`);

    const byteSize = utf8ByteLengthOfWellFormedString(candidate.content);
    assertWithinLimit(
      byteSize,
      limits.max_file_bytes,
      `Workspace file ${path}`,
    );
    contentByteSize = checkedAdd(
      contentByteSize,
      byteSize,
      "Workspace content",
    );
    assertWithinLimit(
      contentByteSize,
      limits.max_total_content_bytes,
      "Workspace content",
    );
    const bytes = textEncoder.encode(candidate.content);

    paths.add(path);
    files.push({
      path,
      content: candidate.content,
      archive_path: toWorkspaceArchivePath(path),
      bytes,
    });
  }

  files.sort((left, right) => compareVfsStrings(left.path, right.path));
  assertNoPathCollisions(files.map(({ path }) => path), "invalid_input");
  return {
    files,
    content_byte_size: contentByteSize,
  };
}

export function validatePortablePath(
  path: string,
  limits: WorkspaceArchiveLimits,
  errorCode: "invalid_input" | "invalid_archive",
): string {
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    !isWellFormedString(path)
  ) {
    throw new WorkspaceArchiveError(
      errorCode,
      `Workspace path is not portable: ${JSON.stringify(path)}`,
    );
  }

  let normalized: string;
  try {
    normalized = normalizeFilePath(path);
  } catch (error) {
    if (error instanceof VfsError) {
      throw new WorkspaceArchiveError(
        errorCode,
        `Workspace path is invalid: ${JSON.stringify(path)}`,
      );
    }
    throw error;
  }
  if (normalized !== path) {
    throw new WorkspaceArchiveError(
      errorCode,
      `Workspace path is not canonical: ${JSON.stringify(path)}`,
    );
  }

  const pathBytes = textEncoder.encode(path).byteLength;
  assertWithinLimit(pathBytes, limits.max_path_bytes, `Workspace path ${path}`);
  assertWithinLimit(
    path.split("/").length - 1,
    limits.max_path_depth,
    `Workspace path depth ${path}`,
  );
  return path;
}

export function assertNoPathCollisions(
  paths: Iterable<string>,
  errorCode: "invalid_input" | "invalid_archive",
): void {
  const pathSet = new Set(paths);
  for (const path of pathSet) {
    const segments = path.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = `/${segments.slice(0, index).join("/")}`;
      if (!pathSet.has(ancestor)) continue;
      throw new WorkspaceArchiveError(
        errorCode,
        `Workspace file path collides with a directory: ${ancestor}`,
      );
    }
  }
}

export function toWorkspaceArchivePath(path: string): string {
  return `workspace/${path.slice(1)}`;
}

export function assertSafeZipEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    !isWellFormedString(name)
  ) {
    throw new WorkspaceArchiveError(
      "invalid_archive",
      `ZIP entry name is unsafe: ${JSON.stringify(name)}`,
    );
  }

  const segments = name.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new WorkspaceArchiveError(
      "invalid_archive",
      `ZIP entry name is not canonical: ${JSON.stringify(name)}`,
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function assertWellFormedString(value: string, message: string): void {
  if (isWellFormedString(value)) return;
  throw new WorkspaceArchiveError("invalid_input", message);
}

export function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code > 0xdbff) return false;
    const next = value.charCodeAt(index + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    index += 1;
  }
  return true;
}

export function utf8ByteLengthOfWellFormedString(value: string): number {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      byteLength += 1;
    } else if (code <= 0x7ff) {
      byteLength += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      byteLength += 4;
      index += 1;
    } else {
      byteLength += 3;
    }
  }
  return byteLength;
}
