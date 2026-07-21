export const RESEARCHBOX_DATABASE_VERSION = 2;

export const databaseStores = {
  meta: "meta",
  projects: "projects",
  sessions: "sessions",
  session_documents: "session_documents",
  project_filesystems: "project_filesystems",
  files: "files",
} as const;

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
        workspaces.put({ project_id: String(cursor.primaryKey) });
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
}
