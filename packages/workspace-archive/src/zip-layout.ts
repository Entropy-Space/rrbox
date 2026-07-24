import { checkedAdd } from "./limits.ts";
import { WorkspaceArchiveError } from "./types.ts";

const ZIP16_SENTINEL = 0xffff;
const ZIP32_SENTINEL = 0xffffffff;
const END_RECORD_BYTE_SIZE = 22;
const LOCAL_HEADER_BYTE_SIZE = 30;
const CENTRAL_HEADER_BYTE_SIZE = 46;

export type CanonicalZipEntrySize = {
  name_byte_size: number;
  content_byte_size: number;
};

export function canonicalZipByteSize(
  entries: readonly CanonicalZipEntrySize[],
): number {
  if (entries.length >= ZIP16_SENTINEL) {
    invalidLayout(
      "Workspace contains too many entries for the non-ZIP64 v1 layout.",
    );
  }

  let localByteSize = 0;
  let centralByteSize = 0;
  for (const entry of entries) {
    validateEntrySize(entry);
    if (localByteSize >= ZIP32_SENTINEL) {
      invalidLayout("Workspace ZIP local entry offset requires ZIP64.");
    }

    localByteSize = checkedAdd(
      localByteSize,
      LOCAL_HEADER_BYTE_SIZE + entry.name_byte_size,
      "Workspace archive",
    );
    localByteSize = checkedAdd(
      localByteSize,
      entry.content_byte_size,
      "Workspace archive",
    );
    centralByteSize = checkedAdd(
      centralByteSize,
      CENTRAL_HEADER_BYTE_SIZE + entry.name_byte_size,
      "Workspace archive central directory",
    );
  }

  if (localByteSize >= ZIP32_SENTINEL) {
    invalidLayout("Workspace ZIP central directory offset requires ZIP64.");
  }
  if (centralByteSize >= ZIP32_SENTINEL) {
    invalidLayout("Workspace ZIP central directory size requires ZIP64.");
  }
  const archiveByteSize = checkedAdd(
    checkedAdd(
      localByteSize,
      centralByteSize,
      "Workspace archive",
    ),
    END_RECORD_BYTE_SIZE,
    "Workspace archive",
  );
  if (archiveByteSize >= ZIP32_SENTINEL) {
    invalidLayout("Workspace archive size requires ZIP64.");
  }
  return archiveByteSize;
}

function validateEntrySize(entry: CanonicalZipEntrySize): void {
  if (
    !Number.isSafeInteger(entry.name_byte_size) ||
    entry.name_byte_size < 1 ||
    entry.name_byte_size > 0xffff
  ) {
    invalidLayout("Workspace archive contains an invalid ZIP entry name size.");
  }
  if (
    !Number.isSafeInteger(entry.content_byte_size) ||
    entry.content_byte_size < 0 ||
    entry.content_byte_size >= ZIP32_SENTINEL
  ) {
    invalidLayout("Workspace archive entry size requires ZIP64.");
  }
}

function invalidLayout(message: string): never {
  throw new WorkspaceArchiveError("invalid_input", message);
}
