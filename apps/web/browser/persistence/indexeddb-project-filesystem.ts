import {
  normalizeFilePath,
  normalizePath,
  VfsError,
  type ProjectFileSystemProvider,
  type VfsEntry,
  type VirtualFileSystem,
} from "@researchbox/vfs";
import {
  databaseStores,
  requestResult,
  ResearchBoxDatabase,
  transactionDone,
} from "./database.ts";

type FileRecord = {
  project_id: string;
  path: string;
  content: string;
};

type ProjectFileSystemRecord = {
  project_id: string;
};

export class IndexedDbProjectFileSystemProvider
  implements ProjectFileSystemProvider
{
  private readonly database: ResearchBoxDatabase;
  private readonly seedFiles: Record<string, string>;

  constructor(
    database: ResearchBoxDatabase,
    seedFiles: Record<string, string>,
  ) {
    this.database = database;
    this.seedFiles = { ...seedFiles };
  }

  async create(projectId: string): Promise<VirtualFileSystem> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.files],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const workspaceStore = transaction.objectStore(
      databaseStores.project_filesystems,
    );
    const existing = await requestResult(workspaceStore.get(projectId));
    if (existing !== undefined) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw new Error(`Project filesystem already exists: ${projectId}`);
    }
    workspaceStore.put({ project_id: projectId } satisfies ProjectFileSystemRecord);
    const store = transaction.objectStore(databaseStores.files);
    for (const [path, content] of Object.entries(this.seedFiles)) {
      store.put({
        project_id: projectId,
        path: normalizeFilePath(path),
        content,
      } satisfies FileRecord);
    }
    await completion;
    return new IndexedDbVirtualFileSystem(this.database, projectId);
  }

  async open(projectId: string): Promise<VirtualFileSystem> {
    const database = await this.database.open();
    const transaction = database.transaction(
      databaseStores.project_filesystems,
      "readonly",
    );
    const completion = transactionDone(transaction);
    const record = await requestResult(
      transaction.objectStore(databaseStores.project_filesystems).get(projectId),
    );
    await completion;
    if (record === undefined) {
      throw new Error(`Project filesystem does not exist: ${projectId}`);
    }
    return new IndexedDbVirtualFileSystem(this.database, projectId);
  }

  async delete(projectId: string): Promise<void> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.files],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(databaseStores.files);
    const keys = await requestResult(
      store.index("by_project").getAllKeys(projectId),
    );
    for (const key of keys) store.delete(key);
    transaction
      .objectStore(databaseStores.project_filesystems)
      .delete(projectId);
    await completion;
  }
}

class IndexedDbVirtualFileSystem implements VirtualFileSystem {
  private readonly database: ResearchBoxDatabase;
  private readonly projectId: string;

  constructor(database: ResearchBoxDatabase, projectId: string) {
    this.database = database;
    this.projectId = projectId;
  }

  async list(path: string): Promise<VfsEntry[]> {
    const normalizedPath = normalizePath(path);
    const records = await this.loadProjectFiles();
    if (records.some((record) => record.path === normalizedPath)) {
      throw new VfsError(
        "not_directory",
        `Expected a directory but found a file: ${normalizedPath}`,
      );
    }

    const directory = normalizedPath === "/" ? "/" : `${normalizedPath}/`;
    const entries = new Map<string, VfsEntry>();
    for (const record of records) {
      if (!record.path.startsWith(directory)) continue;
      const remainder = record.path.slice(directory.length);
      if (!remainder) continue;
      const [name, ...rest] = remainder.split("/");
      if (!name) continue;
      const entryPath = `${directory}${name}`.replace("//", "/");
      entries.set(
        name,
        rest.length > 0
          ? { name, path: entryPath, kind: "directory", size: 0 }
          : {
              name,
              path: entryPath,
              kind: "file",
              size: new TextEncoder().encode(record.content).byteLength,
            },
      );
    }
    return [...entries.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  async read(path: string): Promise<string> {
    const normalizedPath = normalizeFilePath(path);
    const records = await this.loadProjectFiles();
    const record = records.find((candidate) => candidate.path === normalizedPath);
    if (record) return record.content;
    if (records.some((candidate) => candidate.path.startsWith(`${normalizedPath}/`))) {
      throw new VfsError("is_directory", `Path is a directory: ${normalizedPath}`);
    }
    throw new VfsError("not_found", `File not found: ${normalizedPath}`);
  }

  async write(path: string, content: string): Promise<void> {
    const normalizedPath = normalizeFilePath(path);
    const database = await this.database.open();
    const transaction = database.transaction(databaseStores.files, "readwrite");
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(databaseStores.files);
    const records = (await requestResult(
      store.index("by_project").getAll(this.projectId),
    )) as FileRecord[];

    try {
      assertWritablePath(records, normalizedPath);
    } catch (error) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw error;
    }

    store.put({
      project_id: this.projectId,
      path: normalizedPath,
      content,
    } satisfies FileRecord);
    await completion;
  }

  private async loadProjectFiles(): Promise<FileRecord[]> {
    const database = await this.database.open();
    const transaction = database.transaction(databaseStores.files, "readonly");
    const completion = transactionDone(transaction);
    const records = (await requestResult(
      transaction
        .objectStore(databaseStores.files)
        .index("by_project")
        .getAll(this.projectId),
    )) as FileRecord[];
    await completion;
    return records;
  }
}

function assertWritablePath(records: FileRecord[], path: string): void {
  if (records.some((record) => record.path.startsWith(`${path}/`))) {
    throw new VfsError(
      "is_directory",
      `Cannot replace a directory with a file: ${path}`,
    );
  }
  const segments = path.split("/").filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = `/${segments.slice(0, index).join("/")}`;
    if (records.some((record) => record.path === ancestor)) {
      throw new VfsError(
        "not_directory",
        `Cannot create a file beneath another file: ${ancestor}`,
      );
    }
  }
}
