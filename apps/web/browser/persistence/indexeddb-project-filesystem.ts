import {
  assertVfsWriteExpectation,
  compareVfsEntries,
  compareWorkspaceChanges,
  createVfsWriteResult,
  incrementWorkspaceRevision,
  normalizeFilePath,
  normalizePath,
  normalizeWorkspaceChangeTimestamp,
  normalizeVfsSeedFiles,
  VfsError,
  WorkspaceBackendError,
  type VfsEntry,
  type VfsRemoveOptions,
  type VfsSeedFile,
  type VfsWriteOptions,
  type Workspace,
  type WorkspaceBackend,
  type WorkspaceChangeRecord,
  type WorkspaceChangesResult,
  type WorkspaceListResult,
  type WorkspaceReadResult,
  type WorkspaceRemoveResult,
  type WorkspaceWriteResult,
} from "@researchbox/vfs";
import {
  databaseStores,
  hasCompleteProjectFileSystemMetadata,
  type OpfsFileRecord,
  ProjectFileSystemMetadataError,
  type ProjectFileSystemRecord,
  repairProjectFileSystemRecord,
  requestResult,
  ResearchBoxDatabase,
  transactionDone,
} from "./database.ts";

type FileRecord = {
  project_id: string;
  path: string;
  content: string;
};

type WorkspaceChangeStorageRecord = Omit<
  WorkspaceChangeRecord,
  "tool_call_block_id" | "legacy_message_id"
> & {
  project_id: string;
  tool_call_block_id?: string | null;
  message_id?: string;
};

export class IndexedDbWorkspaceBackend implements WorkspaceBackend {
  private readonly database: ResearchBoxDatabase;
  private readonly seedFiles: VfsSeedFile[];

  constructor(
    database: ResearchBoxDatabase,
    seedFiles: Record<string, string>,
  ) {
    this.database = database;
    this.seedFiles = normalizeVfsSeedFiles(seedFiles);
  }

  async create(projectId: string): Promise<Workspace> {
    const incarnationId = crypto.randomUUID();
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.files,
        databaseStores.file_changes,
        databaseStores.opfs_files,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const workspaceStore = transaction.objectStore(
      databaseStores.project_filesystems,
    );
    try {
      const storedMarker = (await requestResult(
        workspaceStore.get(projectId),
      )) as Partial<ProjectFileSystemRecord> | undefined;
      let existing: ProjectFileSystemRecord | undefined;
      if (storedMarker !== undefined) {
        if (hasCompleteProjectFileSystemMetadata(storedMarker)) {
          existing = storedMarker;
        } else {
          const changes = (await requestResult(
            transaction
              .objectStore(databaseStores.file_changes)
              .index("by_project")
              .getAll(projectId),
          )) as WorkspaceChangeStorageRecord[];
          existing = repairProjectFileSystemRecord(
            {
              ...storedMarker,
              project_id: projectId,
            },
            changes,
          );
        }
      }
      if (existing?.lifecycle_status === "active") {
        throw new WorkspaceBackendError(
          "already_exists",
          `Project filesystem already exists: ${projectId}`,
        );
      }
      const workspaceRevision = existing?.workspace_revision ?? 0;
      const fileStore = transaction.objectStore(databaseStores.files);
      const changeStore = transaction.objectStore(databaseStores.file_changes);
      const opfsFileStore = transaction.objectStore(
        databaseStores.opfs_files,
      );
      const [fileKeys, changeKeys, opfsFileKeys] = await Promise.all([
        requestResult(fileStore.index("by_project").getAllKeys(projectId)),
        requestResult(changeStore.index("by_project").getAllKeys(projectId)),
        requestResult(opfsFileStore.index("by_project").getAllKeys(projectId)),
      ]);
      for (const key of fileKeys) fileStore.delete(key);
      for (const key of changeKeys) changeStore.delete(key);
      for (const key of opfsFileKeys) opfsFileStore.delete(key);
      workspaceStore.put({
        project_id: projectId,
        incarnation_id: incarnationId,
        workspace_revision: workspaceRevision,
        last_change_at: null,
        lifecycle_status: "active",
        content_storage: "indexeddb",
        opfs_storage_id: null,
        opfs_migration: null,
      } satisfies ProjectFileSystemRecord);
      for (const { path, content } of this.seedFiles) {
        fileStore.put({
          project_id: projectId,
          path,
          content,
        } satisfies FileRecord);
      }
      await completion;
      return new IndexedDbWorkspace(
        this.database,
        projectId,
        incarnationId,
      );
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  async open(projectId: string): Promise<Workspace> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.file_changes,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(databaseStores.project_filesystems);
    try {
      const record = (await requestResult(store.get(projectId))) as
        | Partial<ProjectFileSystemRecord>
        | undefined;
      if (record === undefined) {
        throw new WorkspaceBackendError(
          "not_found",
          `Project filesystem does not exist: ${projectId}`,
        );
      }
      let repaired: ProjectFileSystemRecord;
      if (hasCompleteProjectFileSystemMetadata(record)) {
        repaired = record;
      } else {
        const changes = (await requestResult(
          transaction
            .objectStore(databaseStores.file_changes)
            .index("by_project")
            .getAll(projectId),
        )) as WorkspaceChangeStorageRecord[];
        repaired = repairProjectFileSystemRecord(
          {
            ...record,
            project_id: projectId,
          },
          changes,
        );
        store.put(repaired);
      }
      if (repaired.lifecycle_status === "deleted") {
        await completion;
        throw new WorkspaceBackendError(
          "not_found",
          `Project filesystem does not exist: ${projectId}`,
        );
      }
      assertIndexedDbContentStorage(repaired);
      const incarnationId = repaired.incarnation_id;
      await completion;
      return new IndexedDbWorkspace(
        this.database,
        projectId,
        incarnationId,
      );
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  async delete(projectId: string): Promise<void> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.files,
        databaseStores.file_changes,
        databaseStores.opfs_files,
        databaseStores.meta,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const workspaceStore = transaction.objectStore(
      databaseStores.project_filesystems,
    );
    const fileStore = transaction.objectStore(databaseStores.files);
    const changeStore = transaction.objectStore(databaseStores.file_changes);
    const opfsFileStore = transaction.objectStore(databaseStores.opfs_files);
    const markerRequest = workspaceStore.get(projectId);
    const fileKeysRequest = fileStore.index("by_project").getAllKeys(projectId);
    const changesRequest = changeStore
      .index("by_project")
      .getAll(projectId);
    const opfsFilesRequest = opfsFileStore
      .index("by_project")
      .getAll(projectId);
    try {
      const [storedMarker, fileKeys, changes, opfsFiles] = await Promise.all([
        requestResult(markerRequest) as Promise<
          Partial<ProjectFileSystemRecord> | undefined
        >,
        requestResult(fileKeysRequest),
        requestResult(changesRequest) as Promise<
          WorkspaceChangeStorageRecord[]
        >,
        requestResult(opfsFilesRequest) as Promise<OpfsFileRecord[]>,
      ]);
      let marker: ProjectFileSystemRecord | undefined;
      let markerWasComplete = false;
      if (storedMarker !== undefined) {
        if (hasCompleteProjectFileSystemMetadata(storedMarker)) {
          markerWasComplete = true;
          marker = storedMarker;
        } else {
          marker = repairProjectFileSystemRecord(
            {
              ...storedMarker,
              project_id: projectId,
            },
            changes,
          );
        }
        if (marker.lifecycle_status === "active") {
          assertIndexedDbContentStorage(marker);
        }
      }
      for (const key of fileKeys) fileStore.delete(key);
      for (const change of changes) {
        changeStore.delete([projectId, change.change_id]);
      }
      const cleanupStorageIds = new Set(
        opfsFiles.map((file) => file.storage_id),
      );
      if (marker?.opfs_migration) {
        cleanupStorageIds.add(marker.opfs_migration.storage_id);
      }
      const metaStore = transaction.objectStore(databaseStores.meta);
      for (const storageId of cleanupStorageIds) {
        metaStore.put({
          key: `opfs_cleanup:${crypto.randomUUID()}`,
          record_type: "opfs_cleanup",
          created_by: "indexeddb_backend",
          storage_id: storageId,
          content_id: null,
        });
      }
      for (const file of opfsFiles) {
        opfsFileStore.delete([projectId, file.path]);
      }
      if (marker !== undefined) {
        if (marker.lifecycle_status === "active") {
          workspaceStore.put({
            ...marker,
            workspace_revision: incrementWorkspaceRevision(
              marker.workspace_revision,
            ),
            lifecycle_status: "deleted",
            content_storage: "none",
            opfs_storage_id: null,
            opfs_migration: null,
          } satisfies ProjectFileSystemRecord);
        } else if (!markerWasComplete) {
          workspaceStore.put(marker);
        }
      }
      await completion;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }
}

class IndexedDbWorkspace implements Workspace {
  private readonly database: ResearchBoxDatabase;
  private readonly projectId: string;
  private readonly incarnationId: string;

  constructor(
    database: ResearchBoxDatabase,
    projectId: string,
    incarnationId: string,
  ) {
    this.database = database;
    this.projectId = projectId;
    this.incarnationId = incarnationId;
  }

  async list(path: string): Promise<WorkspaceListResult> {
    const normalizedPath = normalizePath(path);
    const { marker, records } = await this.loadProjectFiles();
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
    return {
      workspace_revision: marker.workspace_revision,
      entries: [...entries.values()].sort(compareVfsEntries),
    };
  }

  async read(path: string): Promise<WorkspaceReadResult> {
    const normalizedPath = normalizeFilePath(path);
    const { marker, records } = await this.loadProjectFiles();
    const record = records.find((candidate) => candidate.path === normalizedPath);
    if (record) {
      return {
        workspace_revision: marker.workspace_revision,
        content: record.content,
      };
    }
    if (records.some((candidate) => candidate.path.startsWith(`${normalizedPath}/`))) {
      throw new VfsError("is_directory", `Path is a directory: ${normalizedPath}`);
    }
    throw new VfsError("not_found", `File not found: ${normalizedPath}`);
  }

  async write(
    path: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<WorkspaceWriteResult> {
    const normalizedPath = normalizeFilePath(path);
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.files,
        databaseStores.file_changes,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(databaseStores.files);

    try {
      const marker = await assertActiveProjectFileSystem(
        transaction,
        this.projectId,
        this.incarnationId,
      );
      const records = (await requestResult(
        store.index("by_project").getAll(this.projectId),
      )) as FileRecord[];
      assertWritablePath(records, normalizedPath);
      const beforeContent =
        records.find((record) => record.path === normalizedPath)?.content ?? null;
      assertVfsWriteExpectation(normalizedPath, beforeContent, options);
      const change =
        options?.change === undefined || beforeContent === content
          ? options?.change
          : normalizeWorkspaceChangeTimestamp(
              options.change,
              marker.last_change_at,
            );
      const result = createVfsWriteResult(
        normalizedPath,
        beforeContent,
        content,
        change,
      );
      let workspaceRevision = marker.workspace_revision;
      if (result.change_kind !== "unchanged") {
        workspaceRevision = incrementWorkspaceRevision(
          marker.workspace_revision,
        );
        store.put({
          project_id: this.projectId,
          path: normalizedPath,
          content,
        } satisfies FileRecord);
        if (result.change) {
          const changeStore = transaction.objectStore(
            databaseStores.file_changes,
          );
          const existingChange = await requestResult(
            changeStore.get([this.projectId, result.change.change_id]),
          );
          if (existingChange !== undefined) {
            throw new VfsError(
              "conflict",
              `Workspace change already exists: ${result.change.change_id}`,
            );
          }
          await requestResult(
            changeStore.add({
              ...result.change,
              project_id: this.projectId,
            } satisfies WorkspaceChangeStorageRecord),
          );
        }
        transaction
          .objectStore(databaseStores.project_filesystems)
          .put({
            ...marker,
            workspace_revision: workspaceRevision,
            last_change_at:
              result.change?.created_at ?? marker.last_change_at,
          } satisfies ProjectFileSystemRecord);
      }
      await completion;
      return {
        workspace_revision: workspaceRevision,
        result,
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  async remove(
    path: string,
    options?: VfsRemoveOptions,
  ): Promise<WorkspaceRemoveResult> {
    const normalizedPath = normalizeFilePath(path);
    const database = await this.database.open();
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.files],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const store = transaction.objectStore(databaseStores.files);

    try {
      const marker = await assertActiveProjectFileSystem(
        transaction,
        this.projectId,
        this.incarnationId,
      );
      const records = (await requestResult(
        store.index("by_project").getAll(this.projectId),
      )) as FileRecord[];
      const record = records.find(
        (candidate) => candidate.path === normalizedPath,
      );
      if (!record) {
        if (
          records.some((candidate) =>
            candidate.path.startsWith(`${normalizedPath}/`),
          )
        ) {
          throw new VfsError(
            "is_directory",
            `Cannot remove a directory as a file: ${normalizedPath}`,
          );
        }
        throw new VfsError("not_found", `File not found: ${normalizedPath}`);
      }
      if (
        options?.expected_content !== undefined &&
        options.expected_content !== record.content
      ) {
        throw new VfsError(
          "conflict",
          `File changed before it could be removed: ${normalizedPath}`,
        );
      }
      store.delete([this.projectId, normalizedPath]);
      const workspaceRevision = incrementWorkspaceRevision(
        marker.workspace_revision,
      );
      transaction
        .objectStore(databaseStores.project_filesystems)
        .put({
          ...marker,
          workspace_revision: workspaceRevision,
        } satisfies ProjectFileSystemRecord);
      await completion;
      return {
        workspace_revision: workspaceRevision,
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  async listChanges(): Promise<WorkspaceChangesResult> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.file_changes],
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await assertActiveProjectFileSystem(
        transaction,
        this.projectId,
        this.incarnationId,
      );
      const records = (await requestResult(
        transaction
          .objectStore(databaseStores.file_changes)
          .index("by_project")
          .getAll(this.projectId),
      )) as WorkspaceChangeStorageRecord[];
      await completion;
      return {
        workspace_revision: marker.workspace_revision,
        changes: records
          .sort(compareWorkspaceChanges)
          .map(toWorkspaceChangeRecord),
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async loadProjectFiles(): Promise<{
    marker: ProjectFileSystemRecord;
    records: FileRecord[];
  }> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.files],
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await assertActiveProjectFileSystem(
        transaction,
        this.projectId,
        this.incarnationId,
      );
      const records = (await requestResult(
        transaction
          .objectStore(databaseStores.files)
          .index("by_project")
          .getAll(this.projectId),
      )) as FileRecord[];
      await completion;
      return { marker, records };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }
}

/** @deprecated Use `IndexedDbWorkspaceBackend`. */
export {
  IndexedDbWorkspaceBackend as IndexedDbProjectFileSystemProvider,
};

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

async function assertActiveProjectFileSystem(
  transaction: IDBTransaction,
  projectId: string,
  incarnationId: string,
): Promise<ProjectFileSystemRecord> {
  const record = (await requestResult(
    transaction.objectStore(databaseStores.project_filesystems).get(projectId),
  )) as Partial<ProjectFileSystemRecord> | undefined;
  if (record === undefined) {
    throw new VfsError(
      "not_found",
      `Project filesystem no longer exists: ${projectId}`,
    );
  }
  if (record.lifecycle_status === "deleted") {
    throw new VfsError(
      "not_found",
      `Project filesystem no longer exists: ${projectId}`,
    );
  }
  if (readIncarnationId(record) !== incarnationId) {
    throw new VfsError(
      "conflict",
      `Project filesystem handle is stale: ${projectId}`,
    );
  }
  if (!hasCompleteProjectFileSystemMetadata(record)) {
    throw new VfsError(
      "conflict",
      `Project filesystem metadata is incomplete; reopen it: ${projectId}`,
    );
  }
  assertIndexedDbContentStorage(record);
  return record;
}

function assertIndexedDbContentStorage(
  record: ProjectFileSystemRecord,
): void {
  if (
    record.lifecycle_status === "active" &&
    record.content_storage === "opfs"
  ) {
    throw new ProjectFileSystemMetadataError(
      `Project filesystem content is stored in OPFS and cannot be opened by the legacy IndexedDB backend: ${record.project_id}`,
    );
  }
}

function readIncarnationId(
  record: Partial<ProjectFileSystemRecord>,
): string | null {
  return typeof record.incarnation_id === "string" &&
    record.incarnation_id.length > 0
    ? record.incarnation_id
    : null;
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
  return {
    change_id: record.change_id,
    session_id: record.session_id,
    tool_call_block_id: toolCallBlockId,
    ...(legacyMessageId === undefined
      ? {}
      : { legacy_message_id: legacyMessageId }),
    assistant_message_index: record.assistant_message_index,
    tool_call_id: record.tool_call_id,
    tool_name: record.tool_name,
    created_at: record.created_at,
    path: record.path,
    change_kind: record.change_kind,
    before_content: record.before_content,
    after_content: record.after_content,
    additions: record.additions,
    deletions: record.deletions,
    byte_size: record.byte_size,
  };
}

async function abortTransaction(
  transaction: IDBTransaction,
  completion: Promise<void>,
  error: unknown,
): Promise<never> {
  try {
    transaction.abort();
  } catch {
    // The transaction already completed or aborted.
  }
  await completion.catch(() => undefined);
  throw error;
}
