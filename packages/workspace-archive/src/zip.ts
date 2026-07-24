import { crc32 } from "./integrity.ts";
import { assertWithinLimit, checkedAdd } from "./limits.ts";
import { assertSafeZipEntryName } from "./paths.ts";
import {
  WORKSPACE_ARCHIVE_MANIFEST_PATH,
  WorkspaceArchiveError,
  type WorkspaceArchiveLimits,
} from "./types.ts";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const SUPPORTED_FLAGS = UTF8_FLAG;
const STORED_METHOD = 0;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const ZIP_NAME_ENCODER = new TextEncoder();
const MANIFEST_NAME_BYTES = ZIP_NAME_ENCODER.encode(
  WORKSPACE_ARCHIVE_MANIFEST_PATH,
);
const WORKSPACE_PREFIX_BYTES = ZIP_NAME_ENCODER.encode("workspace/");

export type AuditedZipEntry = {
  name: string;
  flags: number;
  method: typeof STORED_METHOD;
  crc32: number;
  compressed_size: number;
  uncompressed_size: number;
  local_header_offset: number;
  data_offset: number;
  data_end: number;
  raw_name: Uint8Array;
};

export function auditWorkspaceZip(
  archiveBytes: Uint8Array,
  limits: WorkspaceArchiveLimits,
): AuditedZipEntry[] {
  if (!(archiveBytes instanceof Uint8Array)) {
    throw new WorkspaceArchiveError(
      "invalid_input",
      "Workspace archive bytes must be a Uint8Array.",
    );
  }
  assertWithinLimit(
    archiveBytes.byteLength,
    limits.max_archive_bytes,
    "Workspace archive",
  );
  if (archiveBytes.byteLength >= ZIP64_SENTINEL_32) {
    unsupportedArchive("Workspace archive size requires ZIP64.");
  }

  const eocdOffset = findEndOfCentralDirectory(archiveBytes);
  const diskNumber = readU16(archiveBytes, eocdOffset + 4);
  const centralDirectoryDisk = readU16(archiveBytes, eocdOffset + 6);
  const diskEntryCount = readU16(archiveBytes, eocdOffset + 8);
  const entryCount = readU16(archiveBytes, eocdOffset + 10);
  const centralDirectorySize = readU32(archiveBytes, eocdOffset + 12);
  const centralDirectoryOffset = readU32(archiveBytes, eocdOffset + 16);
  const archiveCommentLength = readU16(archiveBytes, eocdOffset + 20);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    diskEntryCount !== entryCount
  ) {
    invalidArchive("Multi-disk ZIP archives are not supported.");
  }
  if (archiveCommentLength !== 0) {
    invalidArchive("Workspace archive ZIP comments are not allowed.");
  }
  if (
    entryCount === ZIP64_SENTINEL_16 ||
    centralDirectorySize === ZIP64_SENTINEL_32 ||
    centralDirectoryOffset === ZIP64_SENTINEL_32
  ) {
    unsupportedArchive("ZIP64 workspace archives are not supported.");
  }
  if (entryCount === 0) {
    invalidArchive("Workspace archive contains no manifest.");
  }
  if (entryCount - 1 > limits.max_files) {
    throw new WorkspaceArchiveError(
      "limit_exceeded",
      "Workspace archive contains too many entries.",
    );
  }
  if (
    centralDirectoryOffset > eocdOffset ||
    centralDirectorySize > eocdOffset - centralDirectoryOffset ||
    centralDirectoryOffset + centralDirectorySize !== eocdOffset
  ) {
    invalidArchive("ZIP central directory bounds are invalid.");
  }

  const entries = parseCentralDirectory(
    archiveBytes,
    centralDirectoryOffset,
    centralDirectorySize,
    entryCount,
    limits,
  );
  const localEntries = validateLocalEntries(
    archiveBytes,
    entries,
    centralDirectoryOffset,
  );
  validateDeclaredLimits(localEntries, limits);
  return localEntries;
}

export function extractAuditedZipEntry(
  archiveBytes: Uint8Array,
  entry: AuditedZipEntry,
): Uint8Array {
  const compressed = archiveBytes.subarray(entry.data_offset, entry.data_end);
  const content = compressed.slice();

  if (content.byteLength !== entry.uncompressed_size) {
    invalidArchive(
      `ZIP entry ${entry.name} does not match its declared size.`,
    );
  }
  if (crc32(content) !== entry.crc32) {
    invalidArchive(`ZIP entry ${entry.name} failed its CRC-32 check.`);
  }
  return content;
}

function parseCentralDirectory(
  bytes: Uint8Array,
  centralOffset: number,
  centralSize: number,
  entryCount: number,
  limits: WorkspaceArchiveLimits,
): AuditedZipEntry[] {
  const centralEnd = centralOffset + centralSize;
  const entries: AuditedZipEntry[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, offset, 46, "ZIP central directory header");
    if (readU32(bytes, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      invalidArchive("ZIP central directory entry is malformed.");
    }

    const madeBySystem = bytes[offset + 5] ?? 0;
    const flags = readU16(bytes, offset + 8);
    const method = readU16(bytes, offset + 10);
    const checksum = readU32(bytes, offset + 16);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const startDisk = readU16(bytes, offset + 34);
    const internalAttributes = readU16(bytes, offset + 36);
    const externalAttributes = readU32(bytes, offset + 38);
    const localHeaderOffset = readU32(bytes, offset + 42);
    const variableLength = nameLength + extraLength + commentLength;
    assertRange(
      bytes,
      offset + 46,
      variableLength,
      "ZIP central directory fields",
    );
    if (offset + 46 + variableLength > centralEnd) {
      invalidArchive("ZIP central directory entry exceeds its directory.");
    }

    validateFlags(flags);
    validateCompressionMethod(method);
    if (
      compressedSize === ZIP64_SENTINEL_32 ||
      uncompressedSize === ZIP64_SENTINEL_32 ||
      localHeaderOffset === ZIP64_SENTINEL_32 ||
      startDisk !== 0
    ) {
      unsupportedArchive("ZIP64 or multi-disk entries are not supported.");
    }
    if (method === STORED_METHOD && compressedSize !== uncompressedSize) {
      invalidArchive(`Stored ZIP entry has inconsistent sizes.`);
    }

    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    validateExtraFields(
      bytes,
      offset + 46 + nameLength,
      extraLength,
      "central directory entry",
    );
    if (extraLength !== 0 || commentLength !== 0) {
      invalidArchive("Workspace archive ZIP metadata fields are not allowed.");
    }
    validateRawEntryNameLimits(rawName, limits);
    const name = decodeZipName(rawName, (flags & UTF8_FLAG) !== 0);
    assertSafeZipEntryName(name);
    if (isDirectoryEntry(name, madeBySystem, externalAttributes)) {
      invalidArchive(`Directory ZIP entries are not allowed: ${name}`);
    }
    if (internalAttributes !== 0 || externalAttributes !== 0) {
      invalidArchive(`ZIP attributes are not allowed for ${name}.`);
    }
    if (names.has(name)) {
      invalidArchive(`Workspace archive contains a duplicate entry: ${name}`);
    }
    if (localOffsets.has(localHeaderOffset)) {
      invalidArchive("Multiple ZIP entries reference the same local header.");
    }

    names.add(name);
    localOffsets.add(localHeaderOffset);
    entries.push({
      name,
      flags,
      method,
      crc32: checksum,
      compressed_size: compressedSize,
      uncompressed_size: uncompressedSize,
      local_header_offset: localHeaderOffset,
      data_offset: 0,
      data_end: 0,
      raw_name: rawName,
    });
    offset += 46 + variableLength;
  }

  if (offset !== centralEnd) {
    invalidArchive("ZIP central directory contains trailing records.");
  }
  return entries;
}

function validateRawEntryNameLimits(
  rawName: Uint8Array,
  limits: WorkspaceArchiveLimits,
): void {
  if (bytesEqual(rawName, MANIFEST_NAME_BYTES)) return;
  if (
    rawName.byteLength <= WORKSPACE_PREFIX_BYTES.byteLength ||
    !bytesStartWith(rawName, WORKSPACE_PREFIX_BYTES)
  ) {
    invalidArchive("ZIP payload entries must live below workspace/.");
  }

  const logicalPathBytes =
    rawName.byteLength - WORKSPACE_PREFIX_BYTES.byteLength + 1;
  assertWithinLimit(
    logicalPathBytes,
    limits.max_path_bytes,
    "Workspace archive entry path",
  );

  let depth = 1;
  for (
    let index = WORKSPACE_PREFIX_BYTES.byteLength;
    index < rawName.byteLength;
    index += 1
  ) {
    if (rawName[index] === 0x2f) depth += 1;
  }
  assertWithinLimit(
    depth,
    limits.max_path_depth,
    "Workspace archive entry path depth",
  );
}

function validateLocalEntries(
  bytes: Uint8Array,
  entries: AuditedZipEntry[],
  centralOffset: number,
): AuditedZipEntry[] {
  const ordered = entries
    .slice()
    .sort(
      (left, right) =>
        left.local_header_offset - right.local_header_offset,
    );
  let expectedOffset = 0;

  for (const entry of ordered) {
    const offset = entry.local_header_offset;
    if (offset !== expectedOffset) {
      invalidArchive("ZIP local entries overlap or contain untracked bytes.");
    }
    assertRange(bytes, offset, 30, "ZIP local file header");
    if (readU32(bytes, offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      invalidArchive(`ZIP local header is missing for ${entry.name}.`);
    }

    const flags = readU16(bytes, offset + 6);
    const method = readU16(bytes, offset + 8);
    const checksum = readU32(bytes, offset + 14);
    const compressedSize = readU32(bytes, offset + 18);
    const uncompressedSize = readU32(bytes, offset + 22);
    const nameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const variableLength = nameLength + extraLength;
    assertRange(bytes, offset + 30, variableLength, "ZIP local file fields");

    if (
      flags !== entry.flags ||
      method !== entry.method ||
      checksum !== entry.crc32 ||
      compressedSize !== entry.compressed_size ||
      uncompressedSize !== entry.uncompressed_size
    ) {
      invalidArchive(`ZIP headers disagree for entry ${entry.name}.`);
    }
    const localName = bytes.subarray(offset + 30, offset + 30 + nameLength);
    if (!bytesEqual(localName, entry.raw_name)) {
      invalidArchive(`ZIP entry name aliases disagree for ${entry.name}.`);
    }
    validateExtraFields(
      bytes,
      offset + 30 + nameLength,
      extraLength,
      entry.name,
    );
    if (extraLength !== 0) {
      invalidArchive(`ZIP extra fields are not allowed for ${entry.name}.`);
    }

    const dataOffset = offset + 30 + variableLength;
    if (
      dataOffset > centralOffset ||
      entry.compressed_size > centralOffset - dataOffset
    ) {
      invalidArchive(`ZIP entry data is truncated: ${entry.name}`);
    }
    entry.data_offset = dataOffset;
    entry.data_end = dataOffset + entry.compressed_size;
    expectedOffset = entry.data_end;
  }

  if (expectedOffset !== centralOffset) {
    invalidArchive("ZIP local data contains trailing or untracked bytes.");
  }
  if (ordered[0]?.name !== WORKSPACE_ARCHIVE_MANIFEST_PATH) {
    invalidArchive("The workspace manifest must be the first ZIP entry.");
  }
  if (ordered[0]?.method !== STORED_METHOD) {
    invalidArchive("The workspace manifest must be stored without compression.");
  }
  return ordered;
}

function validateDeclaredLimits(
  entries: AuditedZipEntry[],
  limits: WorkspaceArchiveLimits,
): void {
  const manifest = entries[0];
  if (!manifest) invalidArchive("Workspace archive contains no manifest.");
  assertWithinLimit(
    manifest.uncompressed_size,
    limits.max_manifest_bytes,
    "Workspace archive manifest",
  );

  let totalContentBytes = 0;
  for (const entry of entries.slice(1)) {
    assertWithinLimit(
      entry.uncompressed_size,
      limits.max_file_bytes,
      `Workspace archive entry ${entry.name}`,
    );
    totalContentBytes = checkedAdd(
      totalContentBytes,
      entry.uncompressed_size,
      "Workspace archive content",
    );
    assertWithinLimit(
      totalContentBytes,
      limits.max_total_content_bytes,
      "Workspace archive content",
    );
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.byteLength < 22) {
    invalidArchive("ZIP end-of-central-directory record is missing.");
  }
  const earliest = Math.max(
    0,
    bytes.byteLength - 22 - MAX_ZIP_COMMENT_BYTES,
  );

  for (let offset = bytes.byteLength - 22; offset >= earliest; offset -= 1) {
    if (readU32Unchecked(bytes, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = readU16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  invalidArchive("ZIP end-of-central-directory record is invalid.");
}

function validateFlags(flags: number): void {
  if ((flags & DATA_DESCRIPTOR_FLAG) !== 0) {
    unsupportedArchive("ZIP data descriptors are not supported.");
  }
  if ((flags & ~SUPPORTED_FLAGS) !== 0) {
    unsupportedArchive("ZIP entry uses unsupported or encrypted flags.");
  }
}

function validateCompressionMethod(
  method: number,
): asserts method is typeof STORED_METHOD {
  if (method === STORED_METHOD) return;
  if (method === 8) {
    unsupportedArchive(
      "Workspace archive v1 supports only stored ZIP entries; DEFLATE is not accepted.",
    );
  }
  unsupportedArchive(`ZIP compression method ${method} is not supported.`);
}

function validateExtraFields(
  bytes: Uint8Array,
  offset: number,
  length: number,
  entryName: string,
): void {
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (end - cursor < 4) {
      invalidArchive(`ZIP extra fields are malformed for ${entryName}.`);
    }
    const fieldId = readU16(bytes, cursor);
    const fieldLength = readU16(bytes, cursor + 2);
    cursor += 4;
    if (fieldLength > end - cursor) {
      invalidArchive(`ZIP extra fields are truncated for ${entryName}.`);
    }
    if (fieldId === 0x0001) {
      unsupportedArchive("ZIP64 extra fields are not supported.");
    }
    cursor += fieldLength;
  }
}

function decodeZipName(rawName: Uint8Array, utf8: boolean): string {
  if (rawName.byteLength === 0) {
    invalidArchive("ZIP entry has an empty name.");
  }
  if (!utf8 && rawName.some((byte) => byte > 0x7f)) {
    unsupportedArchive("Non-ASCII ZIP names must use the UTF-8 flag.");
  }
  try {
    return new TextDecoder(utf8 ? "utf-8" : "us-ascii", {
      fatal: true,
    }).decode(rawName);
  } catch {
    invalidArchive("ZIP entry name is not valid UTF-8 or ASCII.");
  }
}

function isDirectoryEntry(
  name: string,
  madeBySystem: number,
  externalAttributes: number,
): boolean {
  if (name.endsWith("/") || (externalAttributes & 0x10) !== 0) return true;
  const unixMode = externalAttributes >>> 16;
  return madeBySystem === 3 && (unixMode & 0xf000) === 0x4000;
}

function readU16(bytes: Uint8Array, offset: number): number {
  assertRange(bytes, offset, 2, "ZIP integer");
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  assertRange(bytes, offset, 4, "ZIP integer");
  return readU32Unchecked(bytes, offset);
}

function readU32Unchecked(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function assertRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.byteLength ||
    length > bytes.byteLength - offset
  ) {
    invalidArchive(`${label} is truncated.`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesStartWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  return true;
}

function invalidArchive(message: string): never {
  throw new WorkspaceArchiveError("invalid_archive", message);
}

function unsupportedArchive(message: string): never {
  throw new WorkspaceArchiveError("unsupported_format", message);
}
