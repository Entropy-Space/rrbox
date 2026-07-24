export const RESEARCHBOX_DATABASE_VERSION = 4;

export const databaseStores = {
  meta: "meta",
  projects: "projects",
  sessions: "sessions",
  session_documents: "session_documents",
  project_filesystems: "project_filesystems",
  files: "files",
  file_changes: "file_changes",
} as const;

export type ProjectFileSystemRecord = {
  project_id: string;
  incarnation_id: string;
  workspace_revision: number;
  last_change_at: string | null;
  lifecycle_status: "active" | "deleted";
};

export type StoredWorkspaceChangeTimestamp = {
  created_at?: unknown;
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
          new Error("IndexedDB upgrade is blocked by another ResearchBox tab."),
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
          workspace_revision: 0,
          last_change_at: null,
          lifecycle_status: "active",
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
  if (!database.objectStoreNames.contains(databaseStores.file_changes)) {
    const fileChanges = database.createObjectStore(
      databaseStores.file_changes,
      { keyPath: ["project_id", "change_id"] },
    );
    fileChanges.createIndex("by_project", "project_id", { unique: false });
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
  return (
    typeof record.project_id === "string" &&
    record.project_id.length > 0 &&
    typeof record.incarnation_id === "string" &&
    record.incarnation_id.length > 0 &&
    hasValidRevision &&
    (record.lifecycle_status !== "deleted" ||
      (record.workspace_revision ?? 0) >= 1) &&
    (record.last_change_at === null ||
      canonicalTimestamp(record.last_change_at) === record.last_change_at) &&
    (record.lifecycle_status === "active" ||
      record.lifecycle_status === "deleted")
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

  return {
    ...record,
    project_id: record.project_id,
    incarnation_id:
      typeof record.incarnation_id === "string" &&
      record.incarnation_id.length > 0
        ? record.incarnation_id
        : crypto.randomUUID(),
    workspace_revision: Math.max(
      storedRevision ?? 0,
      changes.length + (lifecycleStatus === "deleted" ? 1 : 0),
    ),
    last_change_at: latestTimestamp,
    lifecycle_status: lifecycleStatus,
  };
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

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
