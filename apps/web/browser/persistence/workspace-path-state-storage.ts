import {
  normalizeFilePath,
  WorkspaceCorruptionError,
} from "@researchbox/vfs";
import {
  databaseStores,
  requestResult,
  type FilePathTombstoneRecord,
} from "./database.ts";

export async function readFilePathTombstone(
  transaction: IDBTransaction,
  expected: {
    project_id: string;
    incarnation_id: string;
    path: string;
    workspace_revision: number;
  },
): Promise<FilePathTombstoneRecord | null> {
  const stored = (await requestResult(
    transaction
      .objectStore(databaseStores.file_path_tombstones)
      .get([expected.project_id, expected.path]),
  )) as Partial<FilePathTombstoneRecord> | undefined;
  if (stored === undefined) return null;
  if (
    stored.project_id !== expected.project_id ||
    stored.incarnation_id !== expected.incarnation_id ||
    stored.path !== expected.path ||
    normalizeFilePath(stored.path) !== stored.path ||
    !Number.isSafeInteger(stored.path_revision) ||
    (stored.path_revision ?? 0) < 1 ||
    (stored.path_revision ?? Number.MAX_SAFE_INTEGER) >
      expected.workspace_revision
  ) {
    throw new WorkspaceCorruptionError(
      `Persisted deleted path generation is invalid: ${expected.path}`,
    );
  }
  return stored as FilePathTombstoneRecord;
}

export function putFilePathTombstone(
  transaction: IDBTransaction,
  record: FilePathTombstoneRecord,
): void {
  transaction
    .objectStore(databaseStores.file_path_tombstones)
    .put(record);
}

export function deleteFilePathTombstone(
  transaction: IDBTransaction,
  projectId: string,
  path: string,
): void {
  transaction
    .objectStore(databaseStores.file_path_tombstones)
    .delete([projectId, path]);
}

export function deleteAncestorFilePathTombstones(
  transaction: IDBTransaction,
  projectId: string,
  path: string,
): void {
  const store = transaction.objectStore(
    databaseStores.file_path_tombstones,
  );
  const segments = path.split("/").filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) {
    store.delete([
      projectId,
      `/${segments.slice(0, index).join("/")}`,
    ]);
  }
}

export async function deleteDescendantFilePathTombstones(
  transaction: IDBTransaction,
  projectId: string,
  path: string,
): Promise<void> {
  const store = transaction.objectStore(
    databaseStores.file_path_tombstones,
  );
  const keys = await requestResult(
    store.index("by_project").getAllKeys(projectId),
  );
  const prefix = `${path}/`;
  for (const key of keys) {
    if (
      !Array.isArray(key) ||
      key[0] !== projectId ||
      typeof key[1] !== "string" ||
      !key[1].startsWith(prefix)
    ) {
      continue;
    }
    store.delete(key);
  }
}

export async function deleteProjectFilePathTombstones(
  transaction: IDBTransaction,
  projectId: string,
): Promise<void> {
  const store = transaction.objectStore(
    databaseStores.file_path_tombstones,
  );
  const keys = await requestResult(
    store.index("by_project").getAllKeys(projectId),
  );
  for (const key of keys) store.delete(key);
}

export function sameFilePathTombstone(
  left: FilePathTombstoneRecord | null,
  right: FilePathTombstoneRecord | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.project_id === right.project_id &&
    left.path === right.path &&
    left.incarnation_id === right.incarnation_id &&
    left.path_revision === right.path_revision
  );
}
