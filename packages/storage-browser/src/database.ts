export const RESEARCHBOX_DATABASE_VERSION = 9;

export const databaseStores = {
  meta: "meta",
  projects: "projects",
  sessions: "sessions",
  session_documents: "session_documents",
  project_filesystems: "project_filesystems",
  files: "files",
  file_path_tombstones: "file_path_tombstones",
  file_changes: "file_changes",
  file_change_quarantines: "file_change_quarantines",
  opfs_files: "opfs_files",
} as const;

type ProjectFileSystemRecordBase = {
  project_id: string;
  incarnation_id: string;
  incarnation_baseline_revision: number;
  workspace_revision: number;
  last_change_at: string | null;
};

export type ProjectFileSystemMigrationRecord = {
  migration_id: string;
  storage_id: string;
  source_workspace_revision: number;
};

type ActiveProjectFileSystemStorageState =
  | {
      content_storage: "indexeddb";
      opfs_storage_id: null;
      opfs_migration: ProjectFileSystemMigrationRecord | null;
    }
  | {
      content_storage: "opfs";
      opfs_storage_id: string;
      opfs_migration: null;
    };

export type ProjectFileSystemRecord = ProjectFileSystemRecordBase &
  (
    | ({ lifecycle_status: "active" } &
        ActiveProjectFileSystemStorageState)
    | {
        lifecycle_status: "deleted";
        content_storage: "none";
        opfs_storage_id: null;
        opfs_migration: null;
      }
  );

export type OpfsFileRecord = {
  project_id: string;
  path: string;
  incarnation_id: string;
  storage_id: string;
  content_id: string;
  byte_size: number;
  migration_id: string | null;
  path_revision?: number;
};

export type FilePathTombstoneRecord = {
  project_id: string;
  path: string;
  incarnation_id: string;
  path_revision: number;
};

export type StoredWorkspaceChangeTimestamp = {
  created_at?: unknown;
  applied_workspace_revision?: unknown;
  reverted_at_workspace_revision?: unknown;
};

export class ProjectFileSystemMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFileSystemMetadataError";
  }
}

export class ResearchBoxDatabase {
  private readonly factory: IDBFactory;
  private readonly databaseName: string;
  private connectionPromise: Promise<IDBDatabase> | null = null;

  constructor(
    factory: IDBFactory = indexedDB,
    databaseName = "researchbox",
  ) {
    this.factory = factory;
    this.databaseName = databaseName;
  }

  open(): Promise<IDBDatabase> {
    const existingConnection = this.connectionPromise;
    if (existingConnection) return existingConnection;

    const connection = this.openConnection();
    this.connectionPromise = connection;
    void connection.catch(() => {
      if (this.connectionPromise === connection) {
        this.connectionPromise = null;
      }
    });
    return connection;
  }

  close(): void {
    const connection = this.connectionPromise;
    this.connectionPromise = null;
    void connection?.then(
      (database) => database.close(),
      () => undefined,
    );
  }

  private openConnection(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let rejected = false;
      const request = this.factory.open(
        this.databaseName,
        RESEARCHBOX_DATABASE_VERSION,
      );
      const rejectOpen = (error: Error) => {
        if (rejected) return;
        rejected = true;
        reject(error);
      };
      request.onupgradeneeded = () =>
        createSchema(request.result, request.transaction);
      request.onerror = () =>
        rejectOpen(request.error ?? new Error("IndexedDB open failed."));
      request.onblocked = () => {
        rejectOpen(
          new Error("IndexedDB upgrade is blocked by another rrbox tab."),
        );
      };
      request.onsuccess = () => {
        const database = request.result;
        if (rejected) {
          database.close();
          return;
        }
        database.onversionchange = () => {
          database.close();
          this.connectionPromise = null;
        };
        resolve(database);
      };
    });
  }
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    };
  });
}

function createSchema(
  database: IDBDatabase,
  transaction: IDBTransaction | null,
): void {
  if (!database.objectStoreNames.contains(databaseStores.meta)) {
    database.createObjectStore(databaseStores.meta, { keyPath: "key" });
  }
  if (!database.objectStoreNames.contains(databaseStores.projects)) {
    database.createObjectStore(databaseStores.projects, {
      keyPath: "project_id",
    });
  }
  if (!database.objectStoreNames.contains(databaseStores.sessions)) {
    const sessions = database.createObjectStore(databaseStores.sessions, {
      keyPath: "session_id",
    });
    sessions.createIndex("by_project", "project_id", { unique: false });
  }
  if (!database.objectStoreNames.contains(databaseStores.session_documents)) {
    database.createObjectStore(databaseStores.session_documents, {
      keyPath: "session_id",
    });
  }
  if (!database.objectStoreNames.contains(databaseStores.project_filesystems)) {
    const workspaces = database.createObjectStore(
      databaseStores.project_filesystems,
      { keyPath: "project_id" },
    );
    const projects = transaction?.objectStore(databaseStores.projects);
    if (projects) {
      const cursorRequest = projects.openKeyCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        workspaces.put({
          project_id: String(cursor.primaryKey),
          incarnation_id: crypto.randomUUID(),
          incarnation_baseline_revision: 0,
          workspace_revision: 0,
          last_change_at: null,
          lifecycle_status: "active",
          content_storage: "indexeddb",
          opfs_storage_id: null,
          opfs_migration: null,
        } satisfies ProjectFileSystemRecord);
        cursor.continue();
      };
    }
  }
  if (!database.objectStoreNames.contains(databaseStores.files)) {
    const files = database.createObjectStore(databaseStores.files, {
      keyPath: ["project_id", "path"],
    });
    files.createIndex("by_project", "project_id", { unique: false });
  }
  if (
    !database.objectStoreNames.contains(
      databaseStores.file_path_tombstones,
    )
  ) {
    const tombstones = database.createObjectStore(
      databaseStores.file_path_tombstones,
      {
        keyPath: ["project_id", "path"],
      },
    );
    tombstones.createIndex("by_project", "project_id", {
      unique: false,
    });
  }
  if (!database.objectStoreNames.contains(databaseStores.file_changes)) {
    const fileChanges = database.createObjectStore(
      databaseStores.file_changes,
      { keyPath: ["project_id", "change_id"] },
    );
    fileChanges.createIndex("by_project", "project_id", { unique: false });
  }
  if (
    !database.objectStoreNames.contains(
      databaseStores.file_change_quarantines,
    )
  ) {
    const quarantine = database.createObjectStore(
      databaseStores.file_change_quarantines,
      {
        keyPath: [
          "project_id",
          "incarnation_id",
          "quarantine_id",
        ],
      },
    );
    quarantine.createIndex("by_project", "project_id", { unique: false });
    quarantine.createIndex(
      "by_workspace",
      ["project_id", "incarnation_id"],
      { unique: false },
    );
    quarantine.createIndex(
      "by_change",
      ["project_id", "incarnation_id", "source_change_id"],
      { unique: false },
    );
  }
  if (!database.objectStoreNames.contains(databaseStores.opfs_files)) {
    const opfsFiles = database.createObjectStore(databaseStores.opfs_files, {
      keyPath: ["project_id", "path"],
    });
    opfsFiles.createIndex("by_project", "project_id", { unique: false });
  }
  if (transaction) {
    migrateProjectFileSystemMetadata(transaction);
  }
}

export function hasCompleteProjectFileSystemMetadata(
  record: Partial<ProjectFileSystemRecord>,
): record is ProjectFileSystemRecord {
  const hasValidRevision =
    Number.isSafeInteger(record.workspace_revision) &&
    (record.workspace_revision ?? -1) >= 0;
  const hasValidIncarnationBaseline =
    Number.isSafeInteger(record.incarnation_baseline_revision) &&
    (record.incarnation_baseline_revision ?? -1) >= 0 &&
    (record.incarnation_baseline_revision ?? Number.MAX_SAFE_INTEGER) <=
      (record.workspace_revision ?? -1);
  return (
    typeof record.project_id === "string" &&
    record.project_id.length > 0 &&
    typeof record.incarnation_id === "string" &&
    record.incarnation_id.length > 0 &&
    hasValidRevision &&
    hasValidIncarnationBaseline &&
    (record.lifecycle_status !== "deleted" ||
      (record.workspace_revision ?? 0) >= 1) &&
    (record.last_change_at === null ||
      canonicalTimestamp(record.last_change_at) === record.last_change_at) &&
    (record.lifecycle_status === "active" ||
      record.lifecycle_status === "deleted") &&
    hasValidProjectFileSystemStorageState(record)
  );
}

export function repairProjectFileSystemRecord(
  record: Partial<ProjectFileSystemRecord> & { project_id: string },
  changes: readonly StoredWorkspaceChangeTimestamp[],
): ProjectFileSystemRecord {
  const lifecycleStatus =
    record.lifecycle_status === "deleted" ? "deleted" : "active";
  const storedRevision =
    Number.isSafeInteger(record.workspace_revision) &&
    (record.workspace_revision ?? -1) >= 0
      ? (record.workspace_revision as number)
      : null;
  if (
    lifecycleStatus === "deleted" &&
    (storedRevision === null || storedRevision < 1)
  ) {
    throw new ProjectFileSystemMetadataError(
      `Deleted project filesystem metadata has no recoverable revision: ${record.project_id}`,
    );
  }
  const latestTimestamp = [
    canonicalTimestamp(record.last_change_at),
    ...changes.map((change) => canonicalTimestamp(change.created_at)),
  ]
    .filter((value): value is string => value !== null)
    .reduce<string | null>(
      (latest, candidate) =>
        latest === null || candidate > latest ? candidate : latest,
      null,
    );
  const recoverableReceiptRevision = changes.reduce(
    (latest, change) =>
      Math.max(
        latest,
        recoverStoredRevision(change.applied_workspace_revision),
        recoverStoredRevision(change.reverted_at_workspace_revision),
      ),
    0,
  );
  const workspaceRevision =
    storedRevision ??
    Math.max(
      changes.length + (lifecycleStatus === "deleted" ? 1 : 0),
      recoverableReceiptRevision,
    );
  const storedIncarnationBaseline =
    record.incarnation_baseline_revision;
  if (
    storedIncarnationBaseline !== undefined &&
    (!Number.isSafeInteger(storedIncarnationBaseline) ||
      storedIncarnationBaseline < 0 ||
      storedIncarnationBaseline > workspaceRevision)
  ) {
    throw new ProjectFileSystemMetadataError(
      `Project filesystem has an invalid incarnation baseline: ${record.project_id}`,
    );
  }
  const earliestAppliedRevision = changes.reduce<number | null>(
    (earliest, change) => {
      const revision = recoverStoredRevision(
        change.applied_workspace_revision,
      );
      if (revision < 1 || revision > workspaceRevision) return earliest;
      return earliest === null ? revision : Math.min(earliest, revision);
    },
    null,
  );
  const incarnationBaselineRevision =
    storedIncarnationBaseline ??
    (earliestAppliedRevision === null
      ? workspaceRevision
      : earliestAppliedRevision - 1);

  const common = {
    project_id: record.project_id,
    incarnation_id:
      typeof record.incarnation_id === "string" &&
      record.incarnation_id.length > 0
        ? record.incarnation_id
        : crypto.randomUUID(),
    incarnation_baseline_revision: incarnationBaselineRevision,
    workspace_revision: workspaceRevision,
    last_change_at: latestTimestamp,
  };
  if (lifecycleStatus === "deleted") {
    return {
      ...common,
      lifecycle_status: "deleted",
      content_storage: "none",
      opfs_storage_id: null,
      opfs_migration: null,
    };
  }
  return {
    ...common,
    lifecycle_status: "active",
    ...repairActiveProjectFileSystemStorageState(record),
  };
}

function recoverStoredRevision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

function migrateProjectFileSystemMetadata(
  transaction: IDBTransaction,
): void {
  const workspaceStore = transaction.objectStore(
    databaseStores.project_filesystems,
  );
  const changeIndex = transaction
    .objectStore(databaseStores.file_changes)
    .index("by_project");
  const cursorRequest = workspaceStore.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const record = cursor.value as Partial<ProjectFileSystemRecord> & {
      project_id: string;
    };
    const changesRequest = changeIndex.getAll(record.project_id);
    changesRequest.onsuccess = () => {
      cursor.update(
        repairProjectFileSystemRecord(
          record,
          changesRequest.result as StoredWorkspaceChangeTimestamp[],
        ),
      );
      cursor.continue();
    };
  };
}

function hasValidProjectFileSystemStorageState(
  record: Partial<ProjectFileSystemRecord>,
): boolean {
  if (record.lifecycle_status === "deleted") {
    return (
      record.content_storage === "none" &&
      record.opfs_storage_id === null &&
      record.opfs_migration === null
    );
  }
  if (record.lifecycle_status !== "active") return false;
  if (record.content_storage === "indexeddb") {
    return (
      record.opfs_storage_id === null &&
      (record.opfs_migration === null ||
        isValidProjectFileSystemMigration(record.opfs_migration))
    );
  }
  return (
    record.content_storage === "opfs" &&
    isNonEmptyString(record.opfs_storage_id) &&
    record.opfs_migration === null
  );
}

function repairActiveProjectFileSystemStorageState(
  record: Partial<ProjectFileSystemRecord>,
): ActiveProjectFileSystemStorageState {
  if (record.content_storage === undefined) {
    if (
      record.opfs_storage_id !== undefined ||
      record.opfs_migration !== undefined
    ) {
      throw invalidStorageMetadata(record.project_id);
    }
    return {
      content_storage: "indexeddb",
      opfs_storage_id: null,
      opfs_migration: null,
    };
  }
  if (record.content_storage === "indexeddb") {
    if (
      (record.opfs_storage_id !== undefined &&
        record.opfs_storage_id !== null) ||
      (record.opfs_migration !== undefined &&
        record.opfs_migration !== null &&
        !isValidProjectFileSystemMigration(record.opfs_migration))
    ) {
      throw invalidStorageMetadata(record.project_id);
    }
    return {
      content_storage: "indexeddb",
      opfs_storage_id: null,
      opfs_migration: record.opfs_migration ?? null,
    };
  }
  if (
    record.content_storage === "opfs" &&
    isNonEmptyString(record.opfs_storage_id) &&
    (record.opfs_migration === undefined || record.opfs_migration === null)
  ) {
    return {
      content_storage: "opfs",
      opfs_storage_id: record.opfs_storage_id,
      opfs_migration: null,
    };
  }
  throw invalidStorageMetadata(record.project_id);
}

function isValidProjectFileSystemMigration(
  value: unknown,
): value is ProjectFileSystemMigrationRecord {
  if (typeof value !== "object" || value === null) return false;
  const migration = value as Partial<ProjectFileSystemMigrationRecord>;
  return (
    isNonEmptyString(migration.migration_id) &&
    isNonEmptyString(migration.storage_id) &&
    Number.isSafeInteger(migration.source_workspace_revision) &&
    (migration.source_workspace_revision ?? -1) >= 0
  );
}

function invalidStorageMetadata(
  projectId: string | undefined,
): ProjectFileSystemMetadataError {
  return new ProjectFileSystemMetadataError(
    `Project filesystem has invalid content storage metadata: ${projectId ?? "unknown"}`,
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
