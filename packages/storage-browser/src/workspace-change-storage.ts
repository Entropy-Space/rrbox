import {
  assertValidWorkspaceChangeRecord,
  WorkspaceCorruptionError,
  type WorkspaceChangeRecord,
} from "@researchbox/vfs";
import {
  databaseStores,
  requestResult,
  type ProjectFileSystemRecord,
  ResearchBoxDatabase,
  transactionDone,
} from "./database.ts";

export type WorkspaceChangeStorageRecord = Omit<
  WorkspaceChangeRecord,
  | "tool_call_block_id"
  | "legacy_message_id"
  | "assistant_message_index"
  | "applied_workspace_revision"
  | "reverted_at_workspace_revision"
> & {
  project_id: string;
  tool_call_block_id?: string | null;
  message_id?: string;
  assistant_message_index?: unknown;
  applied_workspace_revision?: unknown;
  reverted_at_workspace_revision?: unknown;
};

export type WorkspaceChangeQuarantineRecord = {
  project_id: string;
  incarnation_id: string;
  quarantine_id: string;
  source_change_id: string | null;
  source_key: IDBValidKey;
  detected_at: string;
  reason_code: "invalid_receipt";
  reason_message: string;
  workspace_revision: number;
  content_storage: "indexeddb" | "opfs";
};

type StoredWorkspaceChangeExpectation = {
  project_id: string;
  change_id: string;
  incarnation_baseline_revision: number;
  workspace_revision: number;
};

type StoredWorkspaceChangesReadResult = {
  changes: WorkspaceChangeRecord[];
  quarantined_receipt_count: number;
  pending_quarantines: WorkspaceChangeQuarantineRecord[];
};

type StoredWorkspaceChangesReadExpectation = Omit<
  StoredWorkspaceChangeExpectation,
  "change_id"
> & {
  incarnation_id: string;
  content_storage: Extract<
    ProjectFileSystemRecord,
    { lifecycle_status: "active" }
  >["content_storage"];
};

export class WorkspaceChangeQuarantinedError
  extends WorkspaceCorruptionError {
  constructor(changeId: string) {
    super(`Workspace change receipt was quarantined: ${changeId}`);
    this.name = "WorkspaceChangeQuarantinedError";
  }
}

export async function readStoredWorkspaceChanges(
  transaction: IDBTransaction,
  expected: StoredWorkspaceChangesReadExpectation,
): Promise<StoredWorkspaceChangesReadResult> {
  const changeStore = transaction.objectStore(databaseStores.file_changes);
  const changeIndex = changeStore.index("by_project");
  const quarantineStore = transaction.objectStore(
    databaseStores.file_change_quarantines,
  );
  const [records, sourceKeys, storedQuarantines] = await Promise.all([
    requestResult(
      changeIndex.getAll(expected.project_id),
    ) as Promise<WorkspaceChangeStorageRecord[]>,
    requestResult(changeIndex.getAllKeys(expected.project_id)),
    requestResult(
      quarantineStore.index("by_workspace").getAll([
        expected.project_id,
        expected.incarnation_id,
      ]),
    ) as Promise<WorkspaceChangeQuarantineRecord[]>,
  ]);
  if (records.length !== sourceKeys.length) {
    throw new WorkspaceCorruptionError(
      "Persisted workspace change keys do not match their receipts.",
    );
  }

  const changes: WorkspaceChangeRecord[] = [];
  let quarantinedReceiptCount = 0;
  const pendingQuarantines: WorkspaceChangeQuarantineRecord[] = [];
  for (const [index, record] of records.entries()) {
    const sourceKey = sourceKeys[index];
    if (sourceKey === undefined) {
      throw new WorkspaceCorruptionError(
        "Persisted workspace change receipt has no storage key.",
      );
    }
    const sourceChangeId = changeIdFromStorageKey(
      sourceKey,
      expected.project_id,
    );
    try {
      const change = assertValidStoredWorkspaceChangeRecord(record, {
        project_id: expected.project_id,
        change_id: sourceChangeId ?? "",
        incarnation_baseline_revision:
          expected.incarnation_baseline_revision,
        workspace_revision: expected.workspace_revision,
      });
      changes.push(change);
    } catch (error) {
      if (!(error instanceof WorkspaceCorruptionError)) throw error;
      if (
        !storedQuarantines.some((quarantine) =>
          matchesStoredQuarantine(quarantine, sourceKey)
        )
      ) {
        pendingQuarantines.push({
          project_id: expected.project_id,
          incarnation_id: expected.incarnation_id,
          quarantine_id: storageKeyIdentifier(sourceKey),
          source_change_id: sourceChangeId,
          source_key: sourceKey,
          detected_at: new Date().toISOString(),
          reason_code: "invalid_receipt",
          reason_message: error.message,
          workspace_revision: expected.workspace_revision,
          content_storage: expected.content_storage,
        });
      }
      quarantinedReceiptCount += 1;
    }
  }

  return {
    changes,
    quarantined_receipt_count: quarantinedReceiptCount,
    pending_quarantines: pendingQuarantines,
  };
}

export async function persistWorkspaceChangeQuarantines(
  database: ResearchBoxDatabase,
  records: readonly WorkspaceChangeQuarantineRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  try {
    const connection = await database.open();
    const transaction = connection.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.file_change_quarantines,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const expected = records[0];
      if (
        expected === undefined ||
        records.some(
          (record) =>
            record.project_id !== expected.project_id ||
            record.incarnation_id !== expected.incarnation_id,
        )
      ) {
        throw new WorkspaceCorruptionError(
          "Workspace change quarantines span multiple workspace incarnations.",
        );
      }
      const marker = (await requestResult(
        transaction
          .objectStore(databaseStores.project_filesystems)
          .get(expected.project_id),
      )) as Partial<ProjectFileSystemRecord> | undefined;
      if (
        marker?.lifecycle_status !== "active" ||
        marker.incarnation_id !== expected.incarnation_id
      ) {
        await completion;
        return 0;
      }
      const store = transaction.objectStore(
        databaseStores.file_change_quarantines,
      );
      for (const record of records) store.put(record);
      await completion;
      return 0;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction already completed or aborted.
      }
      await completion.catch(() => undefined);
      if (isRecoverableQuarantinePersistenceError(error)) {
        return records.length;
      }
      throw error;
    }
  } catch (error) {
    if (isRecoverableQuarantinePersistenceError(error)) {
      return records.length;
    }
    throw error;
  }
}

export async function readAccessibleStoredWorkspaceChange(
  transaction: IDBTransaction,
  record: WorkspaceChangeStorageRecord,
  expected: StoredWorkspaceChangeExpectation & {
    incarnation_id: string;
  },
): Promise<WorkspaceChangeRecord> {
  try {
    return assertValidStoredWorkspaceChangeRecord(record, expected);
  } catch (error) {
    if (!(error instanceof WorkspaceCorruptionError)) throw error;
    await assertStoredWorkspaceChangeNotQuarantined(
      transaction,
      expected.project_id,
      expected.incarnation_id,
      expected.change_id,
    );
    throw error;
  }
}

async function assertStoredWorkspaceChangeNotQuarantined(
  transaction: IDBTransaction,
  projectId: string,
  incarnationId: string,
  changeId: string,
): Promise<void> {
  const quarantine = await requestResult(
    transaction
      .objectStore(databaseStores.file_change_quarantines)
      .index("by_change")
      .get([projectId, incarnationId, changeId]),
  );
  if (quarantine !== undefined) {
    throw new WorkspaceChangeQuarantinedError(changeId);
  }
}

export async function deleteQuarantinedWorkspaceChanges(
  transaction: IDBTransaction,
  projectId: string,
): Promise<void> {
  const store = transaction.objectStore(
    databaseStores.file_change_quarantines,
  );
  const keys = await requestResult(
    store.index("by_project").getAllKeys(projectId),
  );
  await Promise.all(
    keys.map((key) => requestResult(store.delete(key))),
  );
}

export function assertValidStoredWorkspaceChangeRecord(
  record: WorkspaceChangeStorageRecord,
  expected: StoredWorkspaceChangeExpectation,
): WorkspaceChangeRecord {
  if (
    record.project_id !== expected.project_id ||
    record.change_id !== expected.change_id
  ) {
    throw invalidStoredWorkspaceChangeRecord(
      "does not match its storage identity",
    );
  }
  if (
    record.tool_call_block_id !== undefined &&
    record.tool_call_block_id !== null &&
    (typeof record.tool_call_block_id !== "string" ||
      record.tool_call_block_id.length === 0)
  ) {
    throw invalidStoredWorkspaceChangeRecord(
      "has an invalid tool_call_block_id",
    );
  }
  if (
    record.message_id !== undefined &&
    (typeof record.message_id !== "string" ||
      record.message_id.length === 0)
  ) {
    throw invalidStoredWorkspaceChangeRecord(
      "has an invalid legacy message_id",
    );
  }
  assertStoredNullableWorkspaceRevision(
    record.applied_workspace_revision,
    "applied_workspace_revision",
  );
  assertStoredNullableWorkspaceRevision(
    record.reverted_at_workspace_revision,
    "reverted_at_workspace_revision",
  );

  const change = toWorkspaceChangeRecord(record);
  assertValidWorkspaceChangeRecord(
    change,
    expected.workspace_revision,
  );
  if (
    change.applied_workspace_revision !== null &&
    change.applied_workspace_revision <=
      expected.incarnation_baseline_revision
  ) {
    throw invalidStoredWorkspaceChangeRecord(
      "was not applied in the current workspace incarnation",
    );
  }
  return change;
}

function toWorkspaceChangeRecord(
  record: WorkspaceChangeStorageRecord,
): WorkspaceChangeRecord {
  const toolCallBlockId =
    typeof record.tool_call_block_id === "string" &&
    record.tool_call_block_id.length > 0
      ? record.tool_call_block_id
      : null;
  const legacyMessageId =
    toolCallBlockId === null &&
    typeof record.message_id === "string" &&
    record.message_id.length > 0
      ? record.message_id
      : undefined;
  const assistantMessageIndex =
    Number.isSafeInteger(record.assistant_message_index) &&
    (record.assistant_message_index as number) >= 0
      ? (record.assistant_message_index as number)
      : null;
  return {
    change_id: record.change_id,
    session_id: record.session_id,
    tool_call_block_id: toolCallBlockId,
    ...(legacyMessageId === undefined
      ? {}
      : { legacy_message_id: legacyMessageId }),
    assistant_message_index: assistantMessageIndex,
    tool_call_id: record.tool_call_id,
    tool_name: record.tool_name,
    created_at: record.created_at,
    applied_workspace_revision: normalizeOptionalStoredRevision(
      record.applied_workspace_revision,
    ),
    reverted_at_workspace_revision: normalizeOptionalStoredRevision(
      record.reverted_at_workspace_revision,
    ),
    path: record.path,
    change_kind: record.change_kind,
    before_content: record.before_content,
    after_content: record.after_content,
    additions: record.additions,
    deletions: record.deletions,
    byte_size: record.byte_size,
  };
}

export function assertValidStoredPathRevision(
  value: unknown,
  workspaceRevision: number,
  path: string,
): number {
  if (value === undefined) return 0;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > workspaceRevision
  ) {
    throw new WorkspaceCorruptionError(
      `Persisted workspace path revision is invalid: ${path}`,
    );
  }
  return value as number;
}

function assertStoredNullableWorkspaceRevision(
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidStoredWorkspaceChangeRecord(
      `has an invalid ${field}`,
    );
  }
}

function normalizeOptionalStoredRevision(
  value: unknown,
): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function invalidStoredWorkspaceChangeRecord(
  detail: string,
): WorkspaceCorruptionError {
  return new WorkspaceCorruptionError(
    `Persisted workspace change receipt ${detail}.`,
  );
}

function changeIdFromStorageKey(
  value: IDBValidKey,
  projectId: string,
): string | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== projectId ||
    typeof value[1] !== "string" ||
    value[1].length === 0
  ) {
    return null;
  }
  return value[1];
}

function sameStorageKey(left: IDBValidKey, right: IDBValidKey): boolean {
  if (
    typeof left === "string" ||
    typeof left === "number" ||
    typeof right === "string" ||
    typeof right === "number"
  ) {
    return left === right;
  }
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        sameStorageKey(value, right[index] as IDBValidKey)
      )
    );
  }
  return sameStorageKeyBytes(left, right);
}

function matchesStoredQuarantine(
  quarantine: WorkspaceChangeQuarantineRecord,
  sourceKey: IDBValidKey,
): boolean {
  try {
    return sameStorageKey(quarantine.source_key, sourceKey);
  } catch {
    return false;
  }
}

function sameStorageKeyBytes(
  left: BufferSource,
  right: BufferSource,
): boolean {
  const leftBytes = storageKeyBytes(left);
  const rightBytes = storageKeyBytes(right);
  return (
    leftBytes.length === rightBytes.length &&
    leftBytes.every((value, index) => value === rightBytes[index])
  );
}

function storageKeyBytes(value: BufferSource): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
}

function storageKeyIdentifier(value: IDBValidKey): string {
  if (typeof value === "string") {
    return JSON.stringify(["string", value]);
  }
  if (typeof value === "number") {
    return JSON.stringify(["number", Object.is(value, -0) ? 0 : value]);
  }
  if (value instanceof Date) {
    return JSON.stringify(["date", value.getTime()]);
  }
  if (Array.isArray(value)) {
    return JSON.stringify([
      "array",
      value.map(storageKeyIdentifier),
    ]);
  }
  return JSON.stringify([
    "bytes",
    [...storageKeyBytes(value)],
  ]);
}

function isRecoverableQuarantinePersistenceError(
  error: unknown,
): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "AbortError" ||
      error.name === "UnknownError")
  );
}
