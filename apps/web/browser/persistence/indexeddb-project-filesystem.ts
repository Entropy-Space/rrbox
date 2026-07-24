import {
  applyWorkspaceChangeRevision,
  assertVfsWriteExpectation,
  compareVfsEntries,
  compareVfsStrings,
  compareWorkspaceChanges,
  createVfsWriteResult,
  incrementWorkspaceRevision,
  normalizeFilePath,
  normalizePath,
  normalizeWorkspaceChangeTimestamp,
  normalizeStoredWorkspaceRevision,
  normalizeVfsInitialFiles,
  normalizeVfsSeedFiles,
  snapshotWorkspaceCreateOptions,
  VfsError,
  WorkspaceBackendError,
  type VfsEntry,
  type VfsRemoveOptions,
  type VfsSeedFile,
  type VfsWriteOptions,
  type Workspace,
  type WorkspaceBackend,
  type WorkspaceCreateOptions,
  type WorkspaceChangeResult,
  type WorkspaceChangeRevertResult,
  type WorkspaceChangesResult,
  type WorkspaceFilesSnapshotOptions,
  type WorkspaceFilesSnapshotResult,
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
import {
  assertValidStoredPathRevision,
  assertValidStoredWorkspaceChangeRecord,
  type WorkspaceChangeStorageRecord,
} from "./workspace-change-storage.ts";

type FileRecord = {
  project_id: string;
  path: string;
  content: string;
  path_revision?: number;
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

  async create(
    projectId: string,
    options?: WorkspaceCreateOptions,
  ): Promise<Workspace> {
    const createOptions = snapshotWorkspaceCreateOptions(options);
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
      const initialFiles =
        createOptions?.initial_files === undefined
          ? this.seedFiles
          : normalizeVfsInitialFiles(createOptions.initial_files);
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
        incarnation_baseline_revision: workspaceRevision,
        workspace_revision: workspaceRevision,
        last_change_at: null,
        lifecycle_status: "active",
        content_storage: "indexeddb",
        opfs_storage_id: null,
        opfs_migration: null,
      } satisfies ProjectFileSystemRecord);
      for (const { path, content } of initialFiles) {
        fileStore.put({
          project_id: projectId,
          path,
          content,
          path_revision: workspaceRevision,
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
    return this.deleteWorkspace(projectId);
  }

  private async deleteWorkspace(
    projectId: string,
    expectedIncarnationId?: string,
  ): Promise<void> {
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
      if (
        expectedIncarnationId !== undefined &&
        (marker?.lifecycle_status !== "active" ||
          marker.incarnation_id !== expectedIncarnationId)
      ) {
        await completion;
        return;
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

  async reconcileOrphanedWorkspaces(
    retainedProjectIds: readonly string[],
  ): Promise<void> {
    const retained = new Set(retainedProjectIds);
    const database = await this.database.open();
    const transaction = database.transaction(
      databaseStores.project_filesystems,
      "readonly",
    );
    const completion = transactionDone(transaction);
    let orphanedWorkspaces: Array<{
      project_id: string;
      incarnation_id: string;
    }>;
    try {
      const records = (await requestResult(
        transaction
          .objectStore(databaseStores.project_filesystems)
          .getAll(),
      )) as Array<Partial<ProjectFileSystemRecord>>;
      orphanedWorkspaces = records
        .filter(
          (record): record is Partial<ProjectFileSystemRecord> & {
            project_id: string;
            incarnation_id: string;
          } =>
            typeof record.project_id === "string" &&
            typeof record.incarnation_id === "string" &&
            record.lifecycle_status !== "deleted" &&
            !retained.has(record.project_id),
        )
        .map((record) => ({
          project_id: record.project_id,
          incarnation_id: record.incarnation_id,
        }));
      await completion;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }

    for (const orphan of orphanedWorkspaces) {
      await this.deleteWorkspace(
        orphan.project_id,
        orphan.incarnation_id,
      );
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
        path_revision:
          normalizeStoredWorkspaceRevision(record.path_revision) ?? 0,
        content: record.content,
      };
    }
    if (records.some((candidate) => candidate.path.startsWith(`${normalizedPath}/`))) {
      throw new VfsError("is_directory", `Path is a directory: ${normalizedPath}`);
    }
    throw new VfsError("not_found", `File not found: ${normalizedPath}`);
  }

  async readFilesSnapshot(
    options?: WorkspaceFilesSnapshotOptions,
  ): Promise<WorkspaceFilesSnapshotResult> {
    const { marker, records } = await this.loadProjectFiles(options?.signal);
    throwIfAborted(options?.signal);
    return {
      workspace_revision: marker.workspace_revision,
      files: records
        .map(({ path, content }) => ({ path, content }))
        .sort((left, right) => compareVfsStrings(left.path, right.path)),
    };
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
      let committedResult = result;
      if (result.change_kind !== "unchanged") {
        workspaceRevision = incrementWorkspaceRevision(
          marker.workspace_revision,
        );
        committedResult = applyWorkspaceChangeRevision(
          result,
          workspaceRevision,
        );
        store.put({
          project_id: this.projectId,
          path: normalizedPath,
          content,
          path_revision: workspaceRevision,
        } satisfies FileRecord);
        if (committedResult.change) {
          const changeStore = transaction.objectStore(
            databaseStores.file_changes,
          );
          const existingChange = await requestResult(
            changeStore.get([
              this.projectId,
              committedResult.change.change_id,
            ]),
          );
          if (existingChange !== undefined) {
            throw new VfsError(
              "conflict",
              `Workspace change already exists: ${committedResult.change.change_id}`,
            );
          }
          await requestResult(
            changeStore.add({
              ...committedResult.change,
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
              committedResult.change?.created_at ?? marker.last_change_at,
          } satisfies ProjectFileSystemRecord);
      }
      await completion;
      return {
        workspace_revision: workspaceRevision,
        result: committedResult,
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
          .map((record) =>
            assertValidStoredWorkspaceChangeRecord(record, {
              project_id: this.projectId,
              change_id: record.change_id,
              incarnation_baseline_revision:
                marker.incarnation_baseline_revision,
              workspace_revision: marker.workspace_revision,
            }),
          )
          .sort(compareWorkspaceChanges),
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  async getChange(changeId: string): Promise<WorkspaceChangeResult> {
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
      const record = (await requestResult(
        transaction
          .objectStore(databaseStores.file_changes)
          .get([this.projectId, changeId]),
      )) as WorkspaceChangeStorageRecord | undefined;
      await completion;
      return {
        workspace_revision: marker.workspace_revision,
        change:
          record === undefined
            ? null
            : assertValidStoredWorkspaceChangeRecord(record, {
                project_id: this.projectId,
                change_id: changeId,
                incarnation_baseline_revision:
                  marker.incarnation_baseline_revision,
                workspace_revision: marker.workspace_revision,
              }),
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  async revertChange(
    changeId: string,
  ): Promise<WorkspaceChangeRevertResult> {
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
    try {
      const marker = await assertActiveProjectFileSystem(
        transaction,
        this.projectId,
        this.incarnationId,
      );
      const changeStore = transaction.objectStore(
        databaseStores.file_changes,
      );
      const storedChange = (await requestResult(
        changeStore.get([this.projectId, changeId]),
      )) as WorkspaceChangeStorageRecord | undefined;
      if (storedChange === undefined) {
        throw new VfsError(
          "not_found",
          `Workspace change not found: ${changeId}`,
        );
      }
      const change = assertValidStoredWorkspaceChangeRecord(
        storedChange,
        {
          project_id: this.projectId,
          change_id: changeId,
          incarnation_baseline_revision:
            marker.incarnation_baseline_revision,
          workspace_revision: marker.workspace_revision,
        },
      );
      if (change.reverted_at_workspace_revision !== null) {
        await completion;
        return {
          workspace_revision: marker.workspace_revision,
          revert_outcome: "already_reverted",
          reverted_at_workspace_revision:
            change.reverted_at_workspace_revision,
          change,
        };
      }
      if (change.applied_workspace_revision === null) {
        throw new VfsError(
          "conflict",
          `Workspace change has no safe path revision: ${changeId}`,
        );
      }

      const fileStore = transaction.objectStore(databaseStores.files);
      const storedFile = (await requestResult(
        fileStore.get([this.projectId, change.path]),
      )) as FileRecord | undefined;
      const pathRevision =
        storedFile === undefined
          ? null
          : assertValidStoredPathRevision(
              storedFile.path_revision,
              marker.workspace_revision,
              change.path,
            );
      if (
        storedFile === undefined ||
        storedFile.project_id !== this.projectId ||
        storedFile.path !== change.path ||
        typeof storedFile.content !== "string" ||
        storedFile.content !== change.after_content ||
        pathRevision !== change.applied_workspace_revision
      ) {
        throw new VfsError(
          "conflict",
          `Workspace path changed after receipt was created: ${change.path}`,
        );
      }

      const workspaceRevision = incrementWorkspaceRevision(
        marker.workspace_revision,
      );
      if (change.change_kind === "created") {
        fileStore.delete([this.projectId, change.path]);
      } else {
        const beforeContent = change.before_content;
        if (beforeContent === null) {
          throw new VfsError(
            "conflict",
            `Workspace change cannot be safely reverted: ${changeId}`,
          );
        }
        fileStore.put({
          project_id: this.projectId,
          path: change.path,
          content: beforeContent,
          path_revision: workspaceRevision,
        } satisfies FileRecord);
      }
      const revertedChange = {
        ...storedChange,
        applied_workspace_revision:
          change.applied_workspace_revision,
        reverted_at_workspace_revision: workspaceRevision,
      } satisfies WorkspaceChangeStorageRecord;
      changeStore.put(revertedChange);
      transaction
        .objectStore(databaseStores.project_filesystems)
        .put({
          ...marker,
          workspace_revision: workspaceRevision,
        } satisfies ProjectFileSystemRecord);
      await completion;
      return {
        workspace_revision: workspaceRevision,
        revert_outcome: "applied",
        reverted_at_workspace_revision: workspaceRevision,
        change: assertValidStoredWorkspaceChangeRecord(
          revertedChange,
          {
            project_id: this.projectId,
            change_id: changeId,
            incarnation_baseline_revision:
              marker.incarnation_baseline_revision,
            workspace_revision: workspaceRevision,
          },
        ),
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async loadProjectFiles(signal?: AbortSignal): Promise<{
    marker: ProjectFileSystemRecord;
    records: FileRecord[];
  }> {
    throwIfAborted(signal);
    const database = await this.database.open();
    throwIfAborted(signal);
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.files],
      "readonly",
    );
    const completion = transactionDone(transaction);
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // The transaction already completed or aborted.
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
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
      throwIfAborted(signal);
      return { marker, records };
    } catch (error) {
      return abortTransaction(
        transaction,
        completion,
        signal?.aborted ? abortReason(signal) : error,
      );
    } finally {
      signal?.removeEventListener("abort", abort);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException("The workspace snapshot was aborted.", "AbortError");
}
