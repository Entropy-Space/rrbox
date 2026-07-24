import {
  applyWorkspaceRemoveChangeRevision,
  applyWorkspaceChangeRevision,
  assertVfsWriteExpectation,
  compareVfsEntries,
  compareVfsStrings,
  compareWorkspaceChanges,
  createVfsRemoveResult,
  createVfsWriteResult,
  incrementWorkspaceRevision,
  normalizeFilePath,
  normalizePath,
  normalizeStoredWorkspaceRevision,
  normalizeWorkspaceChangeTimestamp,
  normalizeVfsInitialFiles,
  normalizeVfsSeedFiles,
  snapshotWorkspaceCreateOptions,
  VfsError,
  WorkspaceCorruptionError,
  WorkspaceBackendError,
  type VfsEntry,
  type VfsRemoveOptions,
  type VfsSeedFile,
  type VfsWriteOptions,
  type Workspace,
  type WorkspaceBackend,
  type WorkspaceCreateOptions,
  type WorkspaceChangeResult,
  type WorkspaceChangeRecord,
  type WorkspaceChangeRevertResult,
  type WorkspaceChangesResult,
  type WorkspaceFilesSnapshotOptions,
  type WorkspaceFilesSnapshotReader,
  type WorkspaceFilesSnapshotResult,
  type WorkspaceListResult,
  type WorkspacePathStateResult,
  type WorkspaceReadResult,
  type WorkspaceRemoveResult,
  type WorkspaceWriteResult,
} from "@researchbox/vfs";
import {
  databaseStores,
  type FilePathTombstoneRecord,
  hasCompleteProjectFileSystemMetadata,
  type OpfsFileRecord,
  type ProjectFileSystemRecord,
  repairProjectFileSystemRecord,
  requestResult,
  ResearchBoxDatabase,
  transactionDone,
} from "./database.ts";
import type {
  WorkspaceObjectStore,
  WorkspaceObjectWriteResult,
} from "./opfs-object-store.ts";
import {
  assertValidStoredPathRevision,
  assertValidStoredWorkspaceChangeRecord,
  deleteQuarantinedWorkspaceChanges,
  persistWorkspaceChangeQuarantines,
  readAccessibleStoredWorkspaceChange,
  readStoredWorkspaceChanges,
  type WorkspaceChangeStorageRecord,
} from "./workspace-change-storage.ts";
import {
  deleteAncestorFilePathTombstones,
  deleteDescendantFilePathTombstones,
  deleteFilePathTombstone,
  deleteProjectFilePathTombstones,
  putFilePathTombstone,
  readFilePathTombstone,
  sameFilePathTombstone,
} from "./workspace-path-state-storage.ts";

type InlineFileRecord = {
  project_id: string;
  path: string;
  content: string;
  path_revision?: number;
};

type ActiveOpfsMarker = ProjectFileSystemRecord & {
  lifecycle_status: "active";
  content_storage: "opfs";
  opfs_storage_id: string;
  opfs_migration: null;
};

type ActiveInlineMarker = ProjectFileSystemRecord & {
  lifecycle_status: "active";
  content_storage: "indexeddb";
  opfs_storage_id: null;
};

type PreparedMigrationMarker = ActiveInlineMarker & {
  opfs_migration: {
    migration_id: string;
    storage_id: string;
    source_workspace_revision: number;
  };
};

type OpfsWorkspaceSnapshot = {
  marker: ActiveOpfsMarker;
  files: OpfsFileRecord[];
};

type OpfsWorkspaceChangeSnapshot = OpfsWorkspaceSnapshot & {
  change: WorkspaceChangeRecord;
  path_tombstone: FilePathTombstoneRecord | null;
};

export type OpfsWorkspaceExclusiveRunner = <T>(
  operation: () => Promise<T>,
) => Promise<T>;

type OpfsCleanupRecord = {
  key: string;
  record_type: "opfs_cleanup";
  created_by: string;
  storage_id: string;
  content_id: string | null;
};

const MAX_RETRIES = 8;
const OPFS_CLEANUP_KEY_PREFIX = "opfs_cleanup:";
const SHA256_CONTENT_ID_PATTERN = /^[0-9a-f]{64}$/;

class RetryOpfsOperation extends Error {
  constructor() {
    super("The OPFS workspace changed while the operation was prepared.");
    this.name = "RetryOpfsOperation";
  }
}

/**
 * Stores transactional workspace metadata in IndexedDB and immutable UTF-8
 * content objects in OPFS.
 *
 * OPFS writes always finish before an IndexedDB transaction publishes their
 * object references. A failed publish can leave an unreachable object, but it
 * cannot expose a partial file, receipt, clock, or workspace revision.
 */
export class OpfsWorkspaceBackend implements WorkspaceBackend {
  private readonly database: ResearchBoxDatabase;
  private readonly objects: WorkspaceObjectStore;
  private readonly seedFiles: VfsSeedFile[];
  private readonly runExclusive: OpfsWorkspaceExclusiveRunner;
  private readonly cleanupOwnerId = crypto.randomUUID();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    database: ResearchBoxDatabase,
    objects: WorkspaceObjectStore,
    seedFiles: Record<string, string>,
    runExclusive: OpfsWorkspaceExclusiveRunner =
      runWithNavigatorOpfsLock,
  ) {
    this.database = database;
    this.objects = objects;
    this.seedFiles = normalizeVfsSeedFiles(seedFiles);
    this.runExclusive = runExclusive;
  }

  create(
    projectId: string,
    options?: WorkspaceCreateOptions,
  ): Promise<Workspace> {
    const createOptions = snapshotWorkspaceCreateOptions(options);
    return this.enqueue(async () => {
      const existing = await this.loadAndRepairMarker(projectId);
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

      const incarnationId = crypto.randomUUID();
      const storageId = crypto.randomUUID();
      const namespaceCleanup = await this.scheduleCleanup(
        storageId,
        null,
      );
      const objectWrites = await writeInitialObjects(
        this.objects,
        storageId,
        initialFiles,
      );

      try {
        const database = await this.database.open();
        const transaction = database.transaction(
          [
            databaseStores.project_filesystems,
            databaseStores.files,
            databaseStores.file_path_tombstones,
            databaseStores.file_changes,
            databaseStores.file_change_quarantines,
            databaseStores.opfs_files,
            databaseStores.meta,
          ],
          "readwrite",
        );
        const completion = transactionDone(transaction);
        try {
          const workspaceStore = transaction.objectStore(
            databaseStores.project_filesystems,
          );
          const current = (await requestResult(
            workspaceStore.get(projectId),
          )) as ProjectFileSystemRecord | undefined;
          if (!sameCreationBaseline(existing, current)) {
            if (current?.lifecycle_status === "active") {
              throw new WorkspaceBackendError(
                "already_exists",
                `Project filesystem already exists: ${projectId}`,
              );
            }
            throw new VfsError(
              "conflict",
              `Project filesystem changed while it was being created: ${projectId}`,
            );
          }

          const [inlineKeys, changeKeys, opfsKeys] = await Promise.all([
            requestResult(
              transaction
                .objectStore(databaseStores.files)
                .index("by_project")
                .getAllKeys(projectId),
            ),
            requestResult(
              transaction
                .objectStore(databaseStores.file_changes)
                .index("by_project")
                .getAllKeys(projectId),
            ),
            requestResult(
              transaction
                .objectStore(databaseStores.opfs_files)
                .index("by_project")
                .getAllKeys(projectId),
            ),
          ]);
          const inlineStore = transaction.objectStore(databaseStores.files);
          const changeStore = transaction.objectStore(
            databaseStores.file_changes,
          );
          const opfsStore = transaction.objectStore(databaseStores.opfs_files);
          for (const key of inlineKeys) inlineStore.delete(key);
          for (const key of changeKeys) changeStore.delete(key);
          for (const key of opfsKeys) opfsStore.delete(key);
          await deleteProjectFilePathTombstones(
            transaction,
            projectId,
          );
          await deleteQuarantinedWorkspaceChanges(
            transaction,
            projectId,
          );

          const workspaceRevision = existing?.workspace_revision ?? 0;
          workspaceStore.put({
            project_id: projectId,
            incarnation_id: incarnationId,
            incarnation_baseline_revision: workspaceRevision,
            workspace_revision: workspaceRevision,
            last_change_at: null,
            lifecycle_status: "active",
            content_storage: "opfs",
            opfs_storage_id: storageId,
            opfs_migration: null,
          } satisfies ProjectFileSystemRecord);
          for (const { path, content, object } of objectWrites) {
            assertObjectWriteResult(object, content);
            opfsStore.put({
              project_id: projectId,
              path,
              incarnation_id: incarnationId,
              storage_id: storageId,
              content_id: object.content_id,
              byte_size: object.byte_size,
              migration_id: null,
              path_revision: workspaceRevision,
            } satisfies OpfsFileRecord);
          }
          transaction
            .objectStore(databaseStores.meta)
            .delete(namespaceCleanup.key);
          await completion;
        } catch (error) {
          return abortTransaction(transaction, completion, error);
        }
      } catch (error) {
        throw error;
      }

      return this.createHandle(projectId, incarnationId);
    });
  }

  open(projectId: string): Promise<Workspace> {
    return this.enqueue(async () => {
      const marker = await this.ensureOpfsProject(projectId);
      return this.createHandle(projectId, marker.incarnation_id);
    });
  }

  delete(projectId: string): Promise<void> {
    return this.enqueue(() => this.deleteWorkspace(projectId));
  }

  reconcileOrphanedWorkspaces(
    retainedProjectIds: readonly string[],
  ): Promise<void> {
    const retained = new Set(retainedProjectIds);
    return this.enqueue(async () => {
      const orphaned = await this.listOrphanedWorkspaces(retained);
      for (const orphan of orphaned) {
        await this.deleteWorkspace(
          orphan.project_id,
          orphan.incarnation_id,
        );
      }
    });
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
        databaseStores.file_path_tombstones,
        databaseStores.file_changes,
        databaseStores.file_change_quarantines,
        databaseStores.opfs_files,
        databaseStores.meta,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const storageIds = new Set<string>();
    try {
      const workspaceStore = transaction.objectStore(
        databaseStores.project_filesystems,
      );
      const storedMarker = (await requestResult(
        workspaceStore.get(projectId),
      )) as Partial<ProjectFileSystemRecord> | undefined;
      const fileStore = transaction.objectStore(databaseStores.files);
      const changeStore = transaction.objectStore(
        databaseStores.file_changes,
      );
      const opfsStore = transaction.objectStore(databaseStores.opfs_files);
      const [inlineKeys, changes, opfsFiles] = await Promise.all([
        requestResult(
          fileStore.index("by_project").getAllKeys(projectId),
        ),
        requestResult(
          changeStore.index("by_project").getAll(projectId),
        ) as Promise<WorkspaceChangeStorageRecord[]>,
        requestResult(
          opfsStore.index("by_project").getAll(projectId),
        ) as Promise<OpfsFileRecord[]>,
      ]);

      let marker: ProjectFileSystemRecord | undefined;
      if (storedMarker !== undefined) {
        marker = hasCompleteProjectFileSystemMetadata(storedMarker)
          ? storedMarker
          : repairProjectFileSystemRecord(
              {
                ...storedMarker,
                project_id: projectId,
              },
              changes,
            );
      }
      if (
        expectedIncarnationId !== undefined &&
        (marker?.lifecycle_status !== "active" ||
          marker.incarnation_id !== expectedIncarnationId)
      ) {
        await completion;
        return;
      }
      if (marker?.opfs_storage_id) {
        storageIds.add(marker.opfs_storage_id);
      }
      if (marker?.opfs_migration) {
        storageIds.add(marker.opfs_migration.storage_id);
      }
      for (const file of opfsFiles) storageIds.add(file.storage_id);
      const metaStore = transaction.objectStore(databaseStores.meta);
      for (const storageId of storageIds) {
        metaStore.put(this.createCleanupRecord(storageId, null));
      }

      for (const key of inlineKeys) fileStore.delete(key);
      await deleteProjectFilePathTombstones(transaction, projectId);
      for (const change of changes) {
        changeStore.delete([projectId, change.change_id]);
      }
      await deleteQuarantinedWorkspaceChanges(transaction, projectId);
      for (const file of opfsFiles) {
        opfsStore.delete([projectId, file.path]);
      }

      if (marker?.lifecycle_status === "active") {
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
      } else if (
        storedMarker !== undefined &&
        marker !== undefined &&
        !hasCompleteProjectFileSystemMetadata(storedMarker)
      ) {
        workspaceStore.put(marker);
      }
      await completion;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async listOrphanedWorkspaces(
    retainedProjectIds: ReadonlySet<string>,
  ): Promise<Array<{ project_id: string; incarnation_id: string }>> {
    const database = await this.database.open();
    const transaction = database.transaction(
      databaseStores.project_filesystems,
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const records = (await requestResult(
        transaction
          .objectStore(databaseStores.project_filesystems)
          .getAll(),
      )) as Array<Partial<ProjectFileSystemRecord>>;
      await completion;
      return records
        .filter(
          (record): record is Partial<ProjectFileSystemRecord> & {
            project_id: string;
            incarnation_id: string;
          } =>
            typeof record.project_id === "string" &&
            typeof record.incarnation_id === "string" &&
            record.lifecycle_status !== "deleted" &&
            !retainedProjectIds.has(record.project_id),
        )
        .map((record) => ({
          project_id: record.project_id,
          incarnation_id: record.incarnation_id,
        }));
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private createHandle(
    projectId: string,
    incarnationId: string,
  ): Workspace & WorkspaceFilesSnapshotReader {
    return {
      list: (path) =>
        this.enqueue(() =>
          this.listWorkspace(projectId, incarnationId, path),
        ),
      read: (path) =>
        this.enqueue(() =>
          this.readWorkspace(projectId, incarnationId, path),
        ),
      getPathState: (path) =>
        this.enqueue(() =>
          this.readWorkspacePathState(
            projectId,
            incarnationId,
            path,
          ),
        ),
      readFilesSnapshot: (options) =>
        this.enqueue(() =>
          this.readWorkspaceFilesSnapshot(
            projectId,
            incarnationId,
            options,
          ),
        ),
      write: (path, content, options) =>
        this.enqueue(() =>
          this.writeWorkspace(
            projectId,
            incarnationId,
            path,
            content,
            options,
          ),
        ),
      remove: (path, options) =>
        this.enqueue(() =>
          this.removeWorkspace(
            projectId,
            incarnationId,
            path,
            options,
          ),
        ),
      listChanges: () =>
        this.enqueue(() =>
          this.listWorkspaceChanges(projectId, incarnationId),
        ),
      getChange: (changeId) =>
        this.enqueue(() =>
          this.getWorkspaceChange(
            projectId,
            incarnationId,
            changeId,
          ),
        ),
      revertChange: (changeId) =>
        this.enqueue(() =>
          this.revertWorkspaceChange(
            projectId,
            incarnationId,
            changeId,
          ),
        ),
    };
  }

  private async readWorkspaceFilesSnapshot(
    projectId: string,
    incarnationId: string,
    options?: WorkspaceFilesSnapshotOptions,
  ): Promise<WorkspaceFilesSnapshotResult> {
    throwIfAborted(options?.signal);
    const { marker, files } = await this.loadOpfsSnapshot(
      projectId,
      incarnationId,
    );
    const capturedFiles: VfsSeedFile[] = [];
    for (const file of files) {
      throwIfAborted(options?.signal);
      const content = await this.objects.read(
        file.storage_id,
        file.content_id,
      );
      assertObjectByteSize(file, content);
      capturedFiles.push({ path: file.path, content });
    }
    throwIfAborted(options?.signal);
    return {
      workspace_revision: marker.workspace_revision,
      files: capturedFiles.sort((left, right) =>
        compareVfsStrings(left.path, right.path),
      ),
    };
  }

  private async listWorkspace(
    projectId: string,
    incarnationId: string,
    path: string,
  ): Promise<WorkspaceListResult> {
    const normalizedPath = normalizePath(path);
    const { marker, files } = await this.loadOpfsSnapshot(
      projectId,
      incarnationId,
    );
    if (files.some((file) => file.path === normalizedPath)) {
      throw new VfsError(
        "not_directory",
        `Expected a directory but found a file: ${normalizedPath}`,
      );
    }

    return {
      workspace_revision: marker.workspace_revision,
      entries: listEntries(files, normalizedPath),
    };
  }

  private async readWorkspace(
    projectId: string,
    incarnationId: string,
    path: string,
  ): Promise<WorkspaceReadResult> {
    const normalizedPath = normalizeFilePath(path);
    const { marker, files } = await this.loadOpfsSnapshot(
      projectId,
      incarnationId,
    );
    const record = files.find((candidate) => candidate.path === normalizedPath);
    if (!record) {
      if (hasDescendants(files, normalizedPath)) {
        throw new VfsError(
          "is_directory",
          `Path is a directory: ${normalizedPath}`,
        );
      }
      throw new VfsError(
        "not_found",
        `File not found: ${normalizedPath}`,
      );
    }

    const content = await this.objects.read(
      record.storage_id,
      record.content_id,
    );
    assertObjectByteSize(record, content);
    return {
      workspace_revision: marker.workspace_revision,
      path_revision:
        normalizeStoredWorkspaceRevision(record.path_revision) ?? 0,
      content,
    };
  }

  private async readWorkspacePathState(
    projectId: string,
    incarnationId: string,
    path: string,
  ): Promise<WorkspacePathStateResult> {
    const normalizedPath = normalizePath(path);
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.opfs_files,
        databaseStores.file_path_tombstones,
      ],
      "readonly",
    );
    const completion = transactionDone(transaction);
    let marker: ActiveOpfsMarker;
    let files: OpfsFileRecord[];
    let tombstone: FilePathTombstoneRecord | null;
    try {
      marker = await readActiveOpfsMarker(
        transaction,
        projectId,
        incarnationId,
      );
      files = (await requestResult(
        transaction
          .objectStore(databaseStores.opfs_files)
          .index("by_project")
          .getAll(projectId),
      )) as OpfsFileRecord[];
      assertOpfsFileSet(marker, files);
      tombstone = normalizedPath === "/"
        ? null
        : await readFilePathTombstone(transaction, {
            project_id: projectId,
            incarnation_id: marker.incarnation_id,
            path: normalizedPath,
            workspace_revision: marker.workspace_revision,
          });
      await completion;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }

    const record = files.find(
      (candidate) => candidate.path === normalizedPath,
    );
    if (record) {
      if (tombstone !== null) {
        throw new WorkspaceCorruptionError(
          `Workspace path is both present and deleted: ${normalizedPath}`,
        );
      }
      const content = await this.objects.read(
        record.storage_id,
        record.content_id,
      );
      assertObjectByteSize(record, content);
      return {
        workspace_revision: marker.workspace_revision,
        path: normalizedPath,
        kind: "file",
        path_revision: assertValidStoredPathRevision(
          record.path_revision,
          marker.workspace_revision,
          normalizedPath,
        ),
        content,
      };
    }
    if (
      normalizedPath === "/" ||
      hasDescendants(files, normalizedPath)
    ) {
      return {
        workspace_revision: marker.workspace_revision,
        path: normalizedPath,
        kind: "directory",
        path_revision: null,
      };
    }
    return {
      workspace_revision: marker.workspace_revision,
      path: normalizedPath,
      kind: "missing",
      path_revision: tombstone?.path_revision ?? null,
    };
  }

  private async writeWorkspace(
    projectId: string,
    incarnationId: string,
    path: string,
    content: string,
    options?: VfsWriteOptions,
  ): Promise<WorkspaceWriteResult> {
    const normalizedPath = normalizeFilePath(path);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const snapshot = await this.loadOpfsSnapshot(
        projectId,
        incarnationId,
      );
      assertWritablePath(snapshot.files, normalizedPath);
      const existing = snapshot.files.find(
        (candidate) => candidate.path === normalizedPath,
      );
      let beforeContent: string | null = null;
      if (existing) {
        beforeContent = await this.objects.read(
          existing.storage_id,
          existing.content_id,
        );
        assertObjectByteSize(existing, beforeContent);
      }
      assertVfsWriteExpectation(normalizedPath, beforeContent, options);
      const change =
        options?.change === undefined || beforeContent === content
          ? options?.change
          : normalizeWorkspaceChangeTimestamp(
              options.change,
              snapshot.marker.last_change_at,
            );
      const result = createVfsWriteResult(
        normalizedPath,
        beforeContent,
        content,
        change,
      );
      if (result.change_kind === "unchanged") {
        return {
          workspace_revision: snapshot.marker.workspace_revision,
          result,
        };
      }

      const identified = await this.objects.identify(content);
      assertObjectWriteResult(identified, content);
      const cleanup = await this.scheduleCleanup(
        snapshot.marker.opfs_storage_id,
        identified.content_id,
      );
      const object = await this.objects.write(
        snapshot.marker.opfs_storage_id,
        content,
      );
      assertObjectWriteResult(object, content);
      if (
        object.content_id !== identified.content_id ||
        object.byte_size !== identified.byte_size
      ) {
        throw new VfsError(
          "conflict",
          "The OPFS object identity changed while it was written.",
        );
      }
      try {
        const workspaceRevision = await this.commitWrite(
          snapshot,
          normalizedPath,
          existing,
          object,
          result.change,
          cleanup.key,
        );
        return {
          workspace_revision: workspaceRevision,
          result: applyWorkspaceChangeRevision(
            result,
            workspaceRevision,
          ),
        };
      } catch (error) {
        if (error instanceof RetryOpfsOperation) continue;
        throw error;
      }
    }
    throw new VfsError(
      "conflict",
      `Workspace remained busy while writing: ${normalizedPath}`,
    );
  }

  private async commitWrite(
    snapshot: OpfsWorkspaceSnapshot,
    path: string,
    previous: OpfsFileRecord | undefined,
    object: WorkspaceObjectWriteResult,
    change: WorkspaceChangeRecord | null,
    cleanupKey: string,
  ): Promise<number> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.opfs_files,
        databaseStores.file_path_tombstones,
        databaseStores.file_changes,
        databaseStores.meta,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await readActiveOpfsMarker(
        transaction,
        snapshot.marker.project_id,
        snapshot.marker.incarnation_id,
      );
      const opfsStore = transaction.objectStore(databaseStores.opfs_files);
      const current = (await requestResult(
        opfsStore.get([snapshot.marker.project_id, path]),
      )) as OpfsFileRecord | undefined;
      const currentTombstone = await readFilePathTombstone(
        transaction,
        {
          project_id: marker.project_id,
          incarnation_id: marker.incarnation_id,
          path,
          workspace_revision: marker.workspace_revision,
        },
      );
      if (current !== undefined && currentTombstone !== null) {
        throw new WorkspaceCorruptionError(
          `Workspace path is both present and deleted: ${path}`,
        );
      }
      if (
        marker.workspace_revision !== snapshot.marker.workspace_revision ||
        marker.opfs_storage_id !== snapshot.marker.opfs_storage_id ||
        !sameOpfsFile(current, previous)
      ) {
        throw new RetryOpfsOperation();
      }

      const workspaceRevision = incrementWorkspaceRevision(
        marker.workspace_revision,
      );
      const committedChange =
        change === null
          ? null
          : {
              ...change,
              applied_workspace_revision: workspaceRevision,
              reverted_at_workspace_revision: null,
            } satisfies WorkspaceChangeRecord;
      if (committedChange) {
        const changeStore = transaction.objectStore(
          databaseStores.file_changes,
        );
        const existingChange = await requestResult(
          changeStore.get([
            snapshot.marker.project_id,
            committedChange.change_id,
          ]),
        );
        if (existingChange !== undefined) {
          throw new VfsError(
            "conflict",
            `Workspace change already exists: ${committedChange.change_id}`,
          );
        }
        changeStore.add({
          ...committedChange,
          project_id: snapshot.marker.project_id,
        } satisfies WorkspaceChangeStorageRecord);
      }

      opfsStore.put({
        project_id: marker.project_id,
        path,
        incarnation_id: marker.incarnation_id,
        storage_id: marker.opfs_storage_id,
        content_id: object.content_id,
        byte_size: object.byte_size,
        migration_id: null,
        path_revision: workspaceRevision,
      } satisfies OpfsFileRecord);
      deleteFilePathTombstone(
        transaction,
        marker.project_id,
        path,
      );
      deleteAncestorFilePathTombstones(
        transaction,
        marker.project_id,
        path,
      );
      await deleteDescendantFilePathTombstones(
        transaction,
        marker.project_id,
        path,
      );
      transaction
        .objectStore(databaseStores.meta)
        .delete(cleanupKey);
      transaction
        .objectStore(databaseStores.project_filesystems)
        .put({
          ...marker,
          workspace_revision: workspaceRevision,
          last_change_at:
            committedChange?.created_at ?? marker.last_change_at,
        } satisfies ProjectFileSystemRecord);
      if (
        previous &&
        !snapshot.files.some(
          (file) =>
            file.path !== path &&
            file.storage_id === previous.storage_id &&
            file.content_id === previous.content_id,
        )
      ) {
        transaction
          .objectStore(databaseStores.meta)
          .put(
            this.createCleanupRecord(
              previous.storage_id,
              previous.content_id,
            ),
          );
      }
      await completion;
      return workspaceRevision;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async removeWorkspace(
    projectId: string,
    incarnationId: string,
    path: string,
    options?: VfsRemoveOptions,
  ): Promise<WorkspaceRemoveResult> {
    const normalizedPath = normalizeFilePath(path);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const snapshot = await this.loadOpfsSnapshot(
        projectId,
        incarnationId,
      );
      const existing = snapshot.files.find(
        (candidate) => candidate.path === normalizedPath,
      );
      if (!existing) {
        if (hasDescendants(snapshot.files, normalizedPath)) {
          throw new VfsError(
            "is_directory",
            `Cannot remove a directory as a file: ${normalizedPath}`,
          );
        }
        throw new VfsError(
          "not_found",
          `File not found: ${normalizedPath}`,
        );
      }
      const content = await this.objects.read(
        existing.storage_id,
        existing.content_id,
      );
      assertObjectByteSize(existing, content);
      if (
        options?.expected_content !== undefined &&
        options.expected_content !== content
      ) {
        throw new VfsError(
          "conflict",
          `File changed before it could be removed: ${normalizedPath}`,
        );
      }
      const requestedResult =
        options?.change === undefined
          ? undefined
          : createVfsRemoveResult(
              normalizedPath,
              content,
              normalizeWorkspaceChangeTimestamp(
                options.change,
                snapshot.marker.last_change_at,
              ),
            );

      try {
        return await this.commitRemove(
          snapshot,
          normalizedPath,
          existing,
          requestedResult,
        );
      } catch (error) {
        if (error instanceof RetryOpfsOperation) continue;
        throw error;
      }
    }
    throw new VfsError(
      "conflict",
      `Workspace remained busy while removing: ${normalizedPath}`,
    );
  }

  private async commitRemove(
    snapshot: OpfsWorkspaceSnapshot,
    path: string,
    previous: OpfsFileRecord,
    requestedResult:
      | ReturnType<typeof createVfsRemoveResult>
      | undefined,
  ): Promise<WorkspaceRemoveResult> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.opfs_files,
        databaseStores.file_path_tombstones,
        databaseStores.file_changes,
        databaseStores.meta,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await readActiveOpfsMarker(
        transaction,
        snapshot.marker.project_id,
        snapshot.marker.incarnation_id,
      );
      const opfsStore = transaction.objectStore(databaseStores.opfs_files);
      const current = (await requestResult(
        opfsStore.get([snapshot.marker.project_id, path]),
      )) as OpfsFileRecord | undefined;
      const currentTombstone = await readFilePathTombstone(
        transaction,
        {
          project_id: marker.project_id,
          incarnation_id: marker.incarnation_id,
          path,
          workspace_revision: marker.workspace_revision,
        },
      );
      if (current !== undefined && currentTombstone !== null) {
        throw new WorkspaceCorruptionError(
          `Workspace path is both present and deleted: ${path}`,
        );
      }
      if (
        marker.workspace_revision !== snapshot.marker.workspace_revision ||
        marker.opfs_storage_id !== snapshot.marker.opfs_storage_id ||
        !sameOpfsFile(current, previous)
      ) {
        throw new RetryOpfsOperation();
      }

      const workspaceRevision = incrementWorkspaceRevision(
        marker.workspace_revision,
      );
      const committedResult =
        requestedResult === undefined
          ? undefined
          : applyWorkspaceRemoveChangeRevision(
              requestedResult,
              workspaceRevision,
            );
      if (committedResult) {
        const changeStore = transaction.objectStore(
          databaseStores.file_changes,
        );
        const existingChange = await requestResult(
          changeStore.get([
            marker.project_id,
            committedResult.change.change_id,
          ]),
        );
        if (existingChange !== undefined) {
          throw new VfsError(
            "conflict",
            `Workspace change already exists: ${committedResult.change.change_id}`,
          );
        }
        changeStore.add({
          ...committedResult.change,
          project_id: marker.project_id,
        } satisfies WorkspaceChangeStorageRecord);
      }
      opfsStore.delete([snapshot.marker.project_id, path]);
      deleteAncestorFilePathTombstones(
        transaction,
        marker.project_id,
        path,
      );
      await deleteDescendantFilePathTombstones(
        transaction,
        marker.project_id,
        path,
      );
      putFilePathTombstone(transaction, {
        project_id: marker.project_id,
        path,
        incarnation_id: marker.incarnation_id,
        path_revision: workspaceRevision,
      } satisfies FilePathTombstoneRecord);
      transaction
        .objectStore(databaseStores.project_filesystems)
        .put({
          ...marker,
          workspace_revision: workspaceRevision,
          last_change_at:
            committedResult?.change.created_at ?? marker.last_change_at,
        } satisfies ProjectFileSystemRecord);
      if (
        !snapshot.files.some(
          (file) =>
            file.path !== path &&
            file.storage_id === previous.storage_id &&
            file.content_id === previous.content_id,
        )
      ) {
        transaction
          .objectStore(databaseStores.meta)
          .put(
            this.createCleanupRecord(
              previous.storage_id,
              previous.content_id,
            ),
          );
      }
      await completion;
      return {
        workspace_revision: workspaceRevision,
        ...(committedResult === undefined
          ? {}
          : { result: committedResult }),
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async listWorkspaceChanges(
    projectId: string,
    incarnationId: string,
  ): Promise<WorkspaceChangesResult> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.file_changes,
        databaseStores.file_change_quarantines,
      ],
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await readActiveOpfsMarker(
        transaction,
        projectId,
        incarnationId,
      );
      const stored = await readStoredWorkspaceChanges(transaction, {
        project_id: projectId,
        incarnation_id: marker.incarnation_id,
        incarnation_baseline_revision:
          marker.incarnation_baseline_revision,
        workspace_revision: marker.workspace_revision,
        content_storage: "opfs",
      });
      await completion;
      const pendingReceiptCount =
        await persistWorkspaceChangeQuarantines(
          this.database,
          stored.pending_quarantines,
        );
      return {
        workspace_revision: marker.workspace_revision,
        changes: stored.changes.sort(compareWorkspaceChanges),
        ...(stored.quarantined_receipt_count === 0
          ? {}
          : {
              quarantine_status: {
                quarantined_receipt_count:
                  stored.quarantined_receipt_count,
                pending_receipt_count: pendingReceiptCount,
              },
            }),
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async getWorkspaceChange(
    projectId: string,
    incarnationId: string,
    changeId: string,
  ): Promise<WorkspaceChangeResult> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.file_changes,
        databaseStores.file_change_quarantines,
      ],
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await readActiveOpfsMarker(
        transaction,
        projectId,
        incarnationId,
      );
      const change = (await requestResult(
        transaction
          .objectStore(databaseStores.file_changes)
          .get([projectId, changeId]),
      )) as WorkspaceChangeStorageRecord | undefined;
      const accessibleChange =
        change === undefined
          ? null
          : await readAccessibleStoredWorkspaceChange(
              transaction,
              change,
              {
                project_id: projectId,
                change_id: changeId,
                incarnation_id: marker.incarnation_id,
                incarnation_baseline_revision:
                  marker.incarnation_baseline_revision,
                workspace_revision: marker.workspace_revision,
              },
            );
      await completion;
      return {
        workspace_revision: marker.workspace_revision,
        change: accessibleChange,
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async revertWorkspaceChange(
    projectId: string,
    incarnationId: string,
    changeId: string,
  ): Promise<WorkspaceChangeRevertResult> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const snapshot = await this.loadOpfsChangeSnapshot(
        projectId,
        incarnationId,
        changeId,
      );
      const { change } = snapshot;
      if (change.reverted_at_workspace_revision !== null) {
        return {
          workspace_revision: snapshot.marker.workspace_revision,
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
      if (
        (change.change_kind === "created" &&
          change.before_content !== null) ||
        (change.change_kind === "updated" &&
          change.before_content === null) ||
        (change.change_kind === "deleted" &&
          (change.before_content === null ||
            change.after_content !== null))
      ) {
        throw new VfsError(
          "conflict",
          `Workspace change cannot be safely reverted: ${changeId}`,
        );
      }

      const previous = snapshot.files.find(
        (file) => file.path === change.path,
      );
      const pathRevision =
        previous === undefined
          ? null
          : assertValidStoredPathRevision(
              previous.path_revision,
              snapshot.marker.workspace_revision,
              change.path,
            );
      const isCurrentGeneration =
        change.change_kind === "deleted"
          ? previous === undefined &&
            !hasDescendants(snapshot.files, change.path) &&
            !hasFileAncestor(snapshot.files, change.path) &&
            snapshot.path_tombstone?.path_revision ===
              change.applied_workspace_revision
          : previous !== undefined &&
            snapshot.path_tombstone === null &&
            pathRevision === change.applied_workspace_revision;
      if (!isCurrentGeneration) {
        throw new VfsError(
          "conflict",
          `Workspace path changed after receipt was created: ${change.path}`,
        );
      }
      if (previous !== undefined) {
        let currentContent: string;
        try {
          currentContent = await this.objects.read(
            previous.storage_id,
            previous.content_id,
          );
          assertObjectByteSize(previous, currentContent);
        } catch {
          throw new VfsError(
            "conflict",
            `Workspace path cannot be verified for revert: ${change.path}`,
          );
        }
        if (currentContent !== change.after_content) {
          throw new VfsError(
            "conflict",
            `Workspace path changed after receipt was created: ${change.path}`,
          );
        }
      }

      let replacement: WorkspaceObjectWriteResult | null = null;
      let cleanupKey: string | null = null;
      if (
        change.change_kind !== "created" &&
        change.before_content !== null
      ) {
        const identified = await this.objects.identify(
          change.before_content,
        );
        assertObjectWriteResult(identified, change.before_content);
        const cleanup = await this.scheduleCleanup(
          snapshot.marker.opfs_storage_id,
          identified.content_id,
        );
        cleanupKey = cleanup.key;
        replacement = await this.objects.write(
          snapshot.marker.opfs_storage_id,
          change.before_content,
        );
        assertObjectWriteResult(replacement, change.before_content);
        if (
          replacement.content_id !== identified.content_id ||
          replacement.byte_size !== identified.byte_size
        ) {
          throw new VfsError(
            "conflict",
            "The OPFS revert object identity changed while it was written.",
          );
        }
      }

      try {
        return await this.commitWorkspaceChangeRevert(
          snapshot,
          previous,
          replacement,
          cleanupKey,
        );
      } catch (error) {
        if (error instanceof RetryOpfsOperation) continue;
        throw error;
      }
    }
    throw new VfsError(
      "conflict",
      `Workspace remained busy while reverting change: ${changeId}`,
    );
  }

  private async commitWorkspaceChangeRevert(
    snapshot: OpfsWorkspaceChangeSnapshot,
    previous: OpfsFileRecord | undefined,
    replacement: WorkspaceObjectWriteResult | null,
    cleanupKey: string | null,
  ): Promise<WorkspaceChangeRevertResult> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.opfs_files,
        databaseStores.file_path_tombstones,
        databaseStores.file_changes,
        databaseStores.file_change_quarantines,
        databaseStores.meta,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await readActiveOpfsMarker(
        transaction,
        snapshot.marker.project_id,
        snapshot.marker.incarnation_id,
      );
      const changeStore = transaction.objectStore(
        databaseStores.file_changes,
      );
      const storedChange = (await requestResult(
        changeStore.get([
          snapshot.marker.project_id,
          snapshot.change.change_id,
        ]),
      )) as WorkspaceChangeStorageRecord | undefined;
      if (storedChange === undefined) {
        throw new VfsError(
          "not_found",
          `Workspace change not found: ${snapshot.change.change_id}`,
        );
      }
      const change = await readAccessibleStoredWorkspaceChange(
        transaction,
        storedChange,
        {
          project_id: snapshot.marker.project_id,
          change_id: snapshot.change.change_id,
          incarnation_id: marker.incarnation_id,
          incarnation_baseline_revision:
            marker.incarnation_baseline_revision,
          workspace_revision: marker.workspace_revision,
        },
      );
      if (!sameImmutableWorkspaceChange(change, snapshot.change)) {
        throw new VfsError(
          "conflict",
          `Workspace change receipt was modified: ${change.change_id}`,
        );
      }
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

      const opfsStore = transaction.objectStore(
        databaseStores.opfs_files,
      );
      const current = (await requestResult(
        opfsStore.get([
          snapshot.marker.project_id,
          snapshot.change.path,
        ]),
      )) as OpfsFileRecord | undefined;
      if (current !== undefined) {
        assertValidStoredPathRevision(
          current.path_revision,
          marker.workspace_revision,
          snapshot.change.path,
        );
      }
      const currentTombstone = await readFilePathTombstone(
        transaction,
        {
          project_id: marker.project_id,
          incarnation_id: marker.incarnation_id,
          path: snapshot.change.path,
          workspace_revision: marker.workspace_revision,
        },
      );
      if (current !== undefined && currentTombstone !== null) {
        throw new WorkspaceCorruptionError(
          `Workspace path is both present and deleted: ${snapshot.change.path}`,
        );
      }
      if (
        marker.workspace_revision !==
          snapshot.marker.workspace_revision ||
        marker.opfs_storage_id !==
          snapshot.marker.opfs_storage_id ||
        !sameOpfsFile(current, previous) ||
        !sameFilePathTombstone(
          currentTombstone,
          snapshot.path_tombstone,
        )
      ) {
        throw new RetryOpfsOperation();
      }

      const workspaceRevision = incrementWorkspaceRevision(
        marker.workspace_revision,
      );
      if (change.change_kind === "created") {
        opfsStore.delete([
          snapshot.marker.project_id,
          change.path,
        ]);
        deleteAncestorFilePathTombstones(
          transaction,
          marker.project_id,
          change.path,
        );
        await deleteDescendantFilePathTombstones(
          transaction,
          marker.project_id,
          change.path,
        );
        putFilePathTombstone(transaction, {
          project_id: marker.project_id,
          path: change.path,
          incarnation_id: marker.incarnation_id,
          path_revision: workspaceRevision,
        } satisfies FilePathTombstoneRecord);
      } else {
        if (replacement === null || cleanupKey === null) {
          throw new VfsError(
            "conflict",
            `Workspace revert was not fully prepared: ${change.change_id}`,
          );
        }
        opfsStore.put({
          project_id: marker.project_id,
          path: change.path,
          incarnation_id: marker.incarnation_id,
          storage_id: marker.opfs_storage_id,
          content_id: replacement.content_id,
          byte_size: replacement.byte_size,
          migration_id: null,
          path_revision: workspaceRevision,
        } satisfies OpfsFileRecord);
        deleteFilePathTombstone(
          transaction,
          marker.project_id,
          change.path,
        );
        deleteAncestorFilePathTombstones(
          transaction,
          marker.project_id,
          change.path,
        );
        await deleteDescendantFilePathTombstones(
          transaction,
          marker.project_id,
          change.path,
        );
        transaction
          .objectStore(databaseStores.meta)
          .delete(cleanupKey);
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
      if (
        previous !== undefined &&
        !snapshot.files.some(
          (file) =>
            file.path !== change.path &&
            file.storage_id === previous.storage_id &&
            file.content_id === previous.content_id,
        )
      ) {
        transaction
          .objectStore(databaseStores.meta)
          .put(
            this.createCleanupRecord(
              previous.storage_id,
              previous.content_id,
            ),
          );
      }
      await completion;
      return {
        workspace_revision: workspaceRevision,
        revert_outcome: "applied",
        reverted_at_workspace_revision: workspaceRevision,
        change: assertValidStoredWorkspaceChangeRecord(
          revertedChange,
          {
            project_id: marker.project_id,
            change_id: change.change_id,
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

  private async loadOpfsChangeSnapshot(
    projectId: string,
    incarnationId: string,
    changeId: string,
  ): Promise<OpfsWorkspaceChangeSnapshot> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.opfs_files,
        databaseStores.file_path_tombstones,
        databaseStores.file_changes,
        databaseStores.file_change_quarantines,
      ],
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await readActiveOpfsMarker(
        transaction,
        projectId,
        incarnationId,
      );
      const [files, storedChange] = await Promise.all([
        requestResult(
          transaction
            .objectStore(databaseStores.opfs_files)
            .index("by_project")
            .getAll(projectId),
        ) as Promise<OpfsFileRecord[]>,
        requestResult(
          transaction
            .objectStore(databaseStores.file_changes)
            .get([projectId, changeId]),
        ) as Promise<WorkspaceChangeStorageRecord | undefined>,
      ]);
      if (storedChange === undefined) {
        throw new VfsError(
          "not_found",
          `Workspace change not found: ${changeId}`,
        );
      }
      assertOpfsFileSet(marker, files);
      const change = await readAccessibleStoredWorkspaceChange(
        transaction,
        storedChange,
        {
          project_id: projectId,
          change_id: changeId,
          incarnation_id: marker.incarnation_id,
          incarnation_baseline_revision:
            marker.incarnation_baseline_revision,
          workspace_revision: marker.workspace_revision,
        },
      );
      const pathTombstone = await readFilePathTombstone(
        transaction,
        {
          project_id: projectId,
          incarnation_id: marker.incarnation_id,
          path: change.path,
          workspace_revision: marker.workspace_revision,
        },
      );
      if (
        pathTombstone !== null &&
        files.some((file) => file.path === change.path)
      ) {
        throw new WorkspaceCorruptionError(
          `Workspace path is both present and deleted: ${change.path}`,
        );
      }
      await completion;
      return {
        marker,
        files: files.sort((left, right) =>
          left.path < right.path
            ? -1
            : left.path > right.path
              ? 1
              : 0,
        ),
        change,
        path_tombstone: pathTombstone,
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async loadOpfsSnapshot(
    projectId: string,
    incarnationId: string,
  ): Promise<OpfsWorkspaceSnapshot> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.opfs_files],
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await readActiveOpfsMarker(
        transaction,
        projectId,
        incarnationId,
      );
      const files = (await requestResult(
        transaction
          .objectStore(databaseStores.opfs_files)
          .index("by_project")
          .getAll(projectId),
      )) as OpfsFileRecord[];
      assertOpfsFileSet(marker, files);
      await completion;
      return {
        marker,
        files: files.sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        ),
      };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async ensureOpfsProject(
    projectId: string,
  ): Promise<ActiveOpfsMarker> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const marker = await this.loadAndRepairMarker(projectId);
      if (marker === undefined || marker.lifecycle_status === "deleted") {
        throw new WorkspaceBackendError(
          "not_found",
          `Project filesystem does not exist: ${projectId}`,
        );
      }
      if (marker.content_storage === "opfs") {
        const opfsMarker = assertActiveOpfsMarker(marker, projectId);
        await this.cleanupInlineFiles(opfsMarker).catch(() => undefined);
        return opfsMarker;
      }
      if (marker.content_storage !== "indexeddb") {
        throw new VfsError(
          "conflict",
          `Project filesystem storage state is invalid: ${projectId}`,
        );
      }

      try {
        const migrated = await this.migrateInlineProject(projectId);
        await this.cleanupInlineFiles(migrated).catch(() => undefined);
        return migrated;
      } catch (error) {
        if (error instanceof RetryOpfsOperation) continue;
        throw error;
      }
    }
    throw new VfsError(
      "conflict",
      `Project filesystem remained busy during OPFS migration: ${projectId}`,
    );
  }

  private async migrateInlineProject(
    projectId: string,
  ): Promise<ActiveOpfsMarker> {
    const prepared = await this.prepareMigration(projectId);
    const snapshot = await this.loadMigrationSnapshot(
      projectId,
      prepared.opfs_migration.migration_id,
    );
    const candidatesByPath = new Map(
      snapshot.opfsFiles.map((file) => [file.path, file]),
    );

    for (const file of snapshot.inlineFiles) {
      const candidate = candidatesByPath.get(file.path);
      if (
        candidate &&
        candidate.incarnation_id === prepared.incarnation_id &&
        candidate.storage_id === prepared.opfs_migration.storage_id &&
        candidate.migration_id ===
          prepared.opfs_migration.migration_id &&
        candidate.byte_size === utf8ByteSize(file.content) &&
        (normalizeStoredWorkspaceRevision(
          candidate.path_revision,
        ) ?? 0) ===
          (normalizeStoredWorkspaceRevision(
            file.path_revision,
          ) ?? 0)
      ) {
        try {
          const existing = await this.objects.read(
            candidate.storage_id,
            candidate.content_id,
          );
          if (existing === file.content) continue;
        } catch {
          // Rewrite a missing or corrupt candidate below.
        }
      }

      const identified = await this.objects.identify(file.content);
      assertObjectWriteResult(identified, file.content);
      const cleanup = await this.scheduleCleanup(
        prepared.opfs_migration.storage_id,
        identified.content_id,
      );
      const object = await this.objects.write(
        prepared.opfs_migration.storage_id,
        file.content,
      );
      assertObjectWriteResult(object, file.content);
      if (
        object.content_id !== identified.content_id ||
        object.byte_size !== identified.byte_size
      ) {
        throw new VfsError(
          "conflict",
          "The OPFS migration object identity changed while it was written.",
        );
      }
      try {
        await this.persistMigrationCandidate(
          prepared,
          file,
          object,
          cleanup.key,
        );
      } catch (error) {
        throw error;
      }
    }

    return this.finalizeMigration(prepared);
  }

  private async prepareMigration(
    projectId: string,
  ): Promise<PreparedMigrationMarker> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.opfs_files,
        databaseStores.meta,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const workspaceStore = transaction.objectStore(
        databaseStores.project_filesystems,
      );
      const marker = (await requestResult(
        workspaceStore.get(projectId),
      )) as ProjectFileSystemRecord | undefined;
      if (marker === undefined || marker.lifecycle_status === "deleted") {
        throw new WorkspaceBackendError(
          "not_found",
          `Project filesystem does not exist: ${projectId}`,
        );
      }
      if (marker.content_storage === "opfs") {
        throw new RetryOpfsOperation();
      }
      const inlineMarker = assertActiveInlineMarker(marker, projectId);
      if (
        inlineMarker.opfs_migration !== null &&
        inlineMarker.opfs_migration.source_workspace_revision ===
          inlineMarker.workspace_revision
      ) {
        await completion;
        return inlineMarker as PreparedMigrationMarker;
      }

      const opfsStore = transaction.objectStore(databaseStores.opfs_files);
      const staleFiles = (await requestResult(
        opfsStore.index("by_project").getAll(projectId),
      )) as OpfsFileRecord[];
      const staleStorageIds = new Set(
        staleFiles.map((file) => file.storage_id),
      );
      if (inlineMarker.opfs_migration) {
        staleStorageIds.add(inlineMarker.opfs_migration.storage_id);
      }
      const metaStore = transaction.objectStore(databaseStores.meta);
      for (const storageId of staleStorageIds) {
        metaStore.put(this.createCleanupRecord(storageId, null));
      }
      for (const file of staleFiles) {
        opfsStore.delete([projectId, file.path]);
      }
      const prepared = {
        ...inlineMarker,
        opfs_migration: {
          migration_id: crypto.randomUUID(),
          storage_id: crypto.randomUUID(),
          source_workspace_revision: inlineMarker.workspace_revision,
        },
      } satisfies PreparedMigrationMarker;
      workspaceStore.put(prepared);
      await completion;
      return prepared;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async loadMigrationSnapshot(
    projectId: string,
    migrationId: string,
  ): Promise<{
    marker: PreparedMigrationMarker;
    inlineFiles: InlineFileRecord[];
    opfsFiles: OpfsFileRecord[];
  }> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.files,
        databaseStores.opfs_files,
      ],
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = assertPreparedMigrationMarker(
        (await requestResult(
          transaction
            .objectStore(databaseStores.project_filesystems)
            .get(projectId),
        )) as ProjectFileSystemRecord | undefined,
        projectId,
        migrationId,
      );
      const [inlineFiles, opfsFiles] = await Promise.all([
        requestResult(
          transaction
            .objectStore(databaseStores.files)
            .index("by_project")
            .getAll(projectId),
        ) as Promise<InlineFileRecord[]>,
        requestResult(
          transaction
            .objectStore(databaseStores.opfs_files)
            .index("by_project")
            .getAll(projectId),
        ) as Promise<OpfsFileRecord[]>,
      ]);
      await completion;
      return { marker, inlineFiles, opfsFiles };
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async persistMigrationCandidate(
    prepared: PreparedMigrationMarker,
    inlineFile: InlineFileRecord,
    object: WorkspaceObjectWriteResult,
    cleanupKey: string,
  ): Promise<void> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.files,
        databaseStores.opfs_files,
        databaseStores.meta,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = assertPreparedMigrationMarker(
        (await requestResult(
          transaction
            .objectStore(databaseStores.project_filesystems)
            .get(prepared.project_id),
        )) as ProjectFileSystemRecord | undefined,
        prepared.project_id,
        prepared.opfs_migration.migration_id,
      );
      if (
        marker.workspace_revision !==
          prepared.opfs_migration.source_workspace_revision ||
        marker.incarnation_id !== prepared.incarnation_id
      ) {
        throw new RetryOpfsOperation();
      }
      const currentInline = (await requestResult(
        transaction
          .objectStore(databaseStores.files)
          .get([prepared.project_id, inlineFile.path]),
      )) as InlineFileRecord | undefined;
      if (currentInline?.content !== inlineFile.content) {
        throw new RetryOpfsOperation();
      }
      transaction.objectStore(databaseStores.opfs_files).put({
        project_id: prepared.project_id,
        path: inlineFile.path,
        incarnation_id: prepared.incarnation_id,
        storage_id: prepared.opfs_migration.storage_id,
        content_id: object.content_id,
        byte_size: object.byte_size,
        migration_id: prepared.opfs_migration.migration_id,
        path_revision:
          normalizeStoredWorkspaceRevision(
            inlineFile.path_revision,
          ) ?? 0,
      } satisfies OpfsFileRecord);
      transaction.objectStore(databaseStores.meta).delete(cleanupKey);
      await completion;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async finalizeMigration(
    prepared: PreparedMigrationMarker,
  ): Promise<ActiveOpfsMarker> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.files,
        databaseStores.opfs_files,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const workspaceStore = transaction.objectStore(
        databaseStores.project_filesystems,
      );
      const storedMarker = (await requestResult(
        workspaceStore.get(prepared.project_id),
      )) as ProjectFileSystemRecord | undefined;
      if (
        storedMarker?.lifecycle_status === "active" &&
        storedMarker.content_storage === "opfs" &&
        storedMarker.incarnation_id === prepared.incarnation_id &&
        storedMarker.opfs_storage_id ===
          prepared.opfs_migration.storage_id
      ) {
        await completion;
        return assertActiveOpfsMarker(storedMarker, prepared.project_id);
      }
      const marker = assertPreparedMigrationMarker(
        storedMarker,
        prepared.project_id,
        prepared.opfs_migration.migration_id,
      );
      if (
        marker.workspace_revision !==
          prepared.opfs_migration.source_workspace_revision ||
        marker.incarnation_id !== prepared.incarnation_id
      ) {
        throw new RetryOpfsOperation();
      }

      const [inlineFiles, opfsFiles] = await Promise.all([
        requestResult(
          transaction
            .objectStore(databaseStores.files)
            .index("by_project")
            .getAll(prepared.project_id),
        ) as Promise<InlineFileRecord[]>,
        requestResult(
          transaction
            .objectStore(databaseStores.opfs_files)
            .index("by_project")
            .getAll(prepared.project_id),
        ) as Promise<OpfsFileRecord[]>,
      ]);
      const matchingOpfsFiles = opfsFiles.filter(
        (file) =>
          file.incarnation_id === prepared.incarnation_id &&
          file.storage_id === prepared.opfs_migration.storage_id &&
          file.migration_id === prepared.opfs_migration.migration_id,
      );
      const inlinePaths = inlineFiles
        .map((file) => file.path)
        .sort();
      const opfsPaths = matchingOpfsFiles
        .map((file) => file.path)
        .sort();
      if (
        opfsFiles.length !== matchingOpfsFiles.length ||
        inlinePaths.length !== opfsPaths.length ||
        inlinePaths.some((path, index) => path !== opfsPaths[index]) ||
        inlineFiles.some((inlineFile) => {
          const opfsFile = matchingOpfsFiles.find(
            (candidate) => candidate.path === inlineFile.path,
          );
          return (
            opfsFile === undefined ||
            !SHA256_CONTENT_ID_PATTERN.test(opfsFile.content_id) ||
            opfsFile.byte_size !== utf8ByteSize(inlineFile.content) ||
            (normalizeStoredWorkspaceRevision(
              opfsFile.path_revision,
            ) ?? 0) !==
              (normalizeStoredWorkspaceRevision(
                inlineFile.path_revision,
              ) ?? 0)
          );
        })
      ) {
        throw new RetryOpfsOperation();
      }

      const opfsStore = transaction.objectStore(databaseStores.opfs_files);
      for (const file of matchingOpfsFiles) {
        opfsStore.put({
          ...file,
          migration_id: null,
        } satisfies OpfsFileRecord);
      }
      const migrated = {
        ...marker,
        content_storage: "opfs",
        opfs_storage_id: prepared.opfs_migration.storage_id,
        opfs_migration: null,
      } satisfies ActiveOpfsMarker;
      workspaceStore.put(migrated);
      await completion;
      return migrated;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async cleanupInlineFiles(
    marker: ActiveOpfsMarker,
  ): Promise<void> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.files],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const current = (await requestResult(
        transaction
          .objectStore(databaseStores.project_filesystems)
          .get(marker.project_id),
      )) as ProjectFileSystemRecord | undefined;
      if (
        current?.lifecycle_status !== "active" ||
        current.content_storage !== "opfs" ||
        current.incarnation_id !== marker.incarnation_id ||
        current.opfs_storage_id !== marker.opfs_storage_id
      ) {
        throw new RetryOpfsOperation();
      }
      const fileStore = transaction.objectStore(databaseStores.files);
      const keys = await requestResult(
        fileStore.index("by_project").getAllKeys(marker.project_id),
      );
      for (const key of keys) fileStore.delete(key);
      await completion;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async loadAndRepairMarker(
    projectId: string,
  ): Promise<ProjectFileSystemRecord | undefined> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [databaseStores.project_filesystems, databaseStores.file_changes],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      const workspaceStore = transaction.objectStore(
        databaseStores.project_filesystems,
      );
      const record = (await requestResult(
        workspaceStore.get(projectId),
      )) as Partial<ProjectFileSystemRecord> | undefined;
      if (record === undefined) {
        await completion;
        return undefined;
      }
      if (hasCompleteProjectFileSystemMetadata(record)) {
        await completion;
        return record;
      }
      const changes = (await requestResult(
        transaction
          .objectStore(databaseStores.file_changes)
          .index("by_project")
          .getAll(projectId),
      )) as WorkspaceChangeStorageRecord[];
      const repaired = repairProjectFileSystemRecord(
        {
          ...record,
          project_id: projectId,
        },
        changes,
      );
      workspaceStore.put(repaired);
      await completion;
      return repaired;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private createCleanupRecord(
    storageId: string,
    contentId: string | null,
  ): OpfsCleanupRecord {
    return {
      key: `${OPFS_CLEANUP_KEY_PREFIX}${crypto.randomUUID()}`,
      record_type: "opfs_cleanup",
      created_by: this.cleanupOwnerId,
      storage_id: storageId,
      content_id: contentId,
    };
  }

  private async scheduleCleanup(
    storageId: string,
    contentId: string | null,
  ): Promise<OpfsCleanupRecord> {
    const database = await this.database.open();
    const transaction = database.transaction(
      databaseStores.meta,
      "readwrite",
    );
    const completion = transactionDone(transaction);
    const cleanup = this.createCleanupRecord(storageId, contentId);
    try {
      transaction
        .objectStore(databaseStores.meta)
        .put(cleanup);
      await completion;
      return cleanup;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private async resumeCleanup(): Promise<void> {
    const database = await this.database.open();
    const cleanupTransaction = database.transaction(
      databaseStores.meta,
      "readonly",
    );
    const cleanupCompletion = transactionDone(cleanupTransaction);
    let cleanupRecords: OpfsCleanupRecord[];
    try {
      const metaRecords = await requestResult(
        cleanupTransaction.objectStore(databaseStores.meta).getAll(),
      ) as unknown[];
      cleanupRecords = metaRecords.filter(
        (record): record is OpfsCleanupRecord =>
          isOpfsCleanupRecord(record),
      );
      await cleanupCompletion;
    } catch (error) {
      return abortTransaction(
        cleanupTransaction,
        cleanupCompletion,
        error,
      );
    }
    if (cleanupRecords.length === 0) return;

    const referenceTransaction = database.transaction(
      [
        databaseStores.project_filesystems,
        databaseStores.opfs_files,
      ],
      "readonly",
    );
    const referenceCompletion = transactionDone(referenceTransaction);
    let markers: Array<Partial<ProjectFileSystemRecord>>;
    let files: OpfsFileRecord[];
    try {
      [markers, files] = await Promise.all([
        requestResult(
          referenceTransaction
            .objectStore(databaseStores.project_filesystems)
            .getAll(),
        ) as Promise<Array<Partial<ProjectFileSystemRecord>>>,
        requestResult(
          referenceTransaction
            .objectStore(databaseStores.opfs_files)
            .getAll(),
        ) as Promise<OpfsFileRecord[]>,
      ]);
      await referenceCompletion;
    } catch (error) {
      return abortTransaction(
        referenceTransaction,
        referenceCompletion,
        error,
      );
    }

    const liveStorageIds = new Set<string>();
    for (const marker of markers) {
      if (
        marker.lifecycle_status === "active" &&
        typeof marker.opfs_storage_id === "string" &&
        marker.opfs_storage_id.length > 0
      ) {
        liveStorageIds.add(marker.opfs_storage_id);
      }
      const migration = marker.opfs_migration as
        | { storage_id?: unknown }
        | null
        | undefined;
      if (
        marker.lifecycle_status === "active" &&
        migration &&
        typeof migration.storage_id === "string" &&
        migration.storage_id.length > 0
      ) {
        liveStorageIds.add(migration.storage_id);
      }
    }

    for (const cleanup of cleanupRecords) {
      const isLive =
        cleanup.content_id === null
          ? liveStorageIds.has(cleanup.storage_id) ||
            files.some((file) => file.storage_id === cleanup.storage_id)
          : files.some(
              (file) =>
                file.storage_id === cleanup.storage_id &&
                file.content_id === cleanup.content_id,
            );
      if (isLive) {
        await this.removeCleanupRecord(cleanup.key).catch(() => undefined);
        continue;
      }
      try {
        if (cleanup.content_id === null) {
          await this.objects.deleteStorage(cleanup.storage_id);
        } else {
          await this.objects.deleteObject(
            cleanup.storage_id,
            cleanup.content_id,
          );
        }
        await this.removeCleanupRecord(cleanup.key);
      } catch {
        // Keep the durable task for the next backend instance.
      }
    }
  }

  private async removeCleanupRecord(key: string): Promise<void> {
    const database = await this.database.open();
    const transaction = database.transaction(
      databaseStores.meta,
      "readwrite",
    );
    const completion = transactionDone(transaction);
    try {
      transaction.objectStore(databaseStores.meta).delete(key);
      await completion;
    } catch (error) {
      return abortTransaction(transaction, completion, error);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const guardedOperation = async () => {
      await this.resumeCleanup().catch(() => undefined);
      return operation();
    };
    const coordinatedOperation = () =>
      this.runExclusive(guardedOperation);
    const result = this.operationTail.then(
      coordinatedOperation,
      coordinatedOperation,
    );
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function readActiveOpfsMarker(
  transaction: IDBTransaction,
  projectId: string,
  incarnationId: string,
): Promise<ActiveOpfsMarker> {
  const marker = (await requestResult(
    transaction
      .objectStore(databaseStores.project_filesystems)
      .get(projectId),
  )) as ProjectFileSystemRecord | undefined;
  if (marker === undefined || marker.lifecycle_status === "deleted") {
    throw new VfsError(
      "not_found",
      `Project filesystem no longer exists: ${projectId}`,
    );
  }
  if (marker.incarnation_id !== incarnationId) {
    throw new VfsError(
      "conflict",
      `Project filesystem handle is stale: ${projectId}`,
    );
  }
  if (!hasCompleteProjectFileSystemMetadata(marker)) {
    throw new VfsError(
      "conflict",
      `Project filesystem metadata is incomplete; reopen it: ${projectId}`,
    );
  }
  return assertActiveOpfsMarker(marker, projectId);
}

function assertActiveOpfsMarker(
  marker: ProjectFileSystemRecord,
  projectId: string,
): ActiveOpfsMarker {
  if (
    marker.lifecycle_status !== "active" ||
    marker.content_storage !== "opfs" ||
    typeof marker.opfs_storage_id !== "string" ||
    marker.opfs_storage_id.length === 0 ||
    marker.opfs_migration !== null
  ) {
    throw new VfsError(
      "conflict",
      `Project filesystem is not backed by OPFS: ${projectId}`,
    );
  }
  return marker as ActiveOpfsMarker;
}

function assertActiveInlineMarker(
  marker: ProjectFileSystemRecord,
  projectId: string,
): ActiveInlineMarker {
  if (
    marker.lifecycle_status !== "active" ||
    marker.content_storage !== "indexeddb" ||
    marker.opfs_storage_id !== null
  ) {
    throw new VfsError(
      "conflict",
      `Project filesystem is not backed by IndexedDB: ${projectId}`,
    );
  }
  return marker as ActiveInlineMarker;
}

function assertPreparedMigrationMarker(
  marker: ProjectFileSystemRecord | undefined,
  projectId: string,
  migrationId: string,
): PreparedMigrationMarker {
  if (marker === undefined || marker.lifecycle_status === "deleted") {
    throw new VfsError(
      "not_found",
      `Project filesystem no longer exists: ${projectId}`,
    );
  }
  const inline = assertActiveInlineMarker(marker, projectId);
  if (
    inline.opfs_migration === null ||
    inline.opfs_migration.migration_id !== migrationId ||
    inline.opfs_migration.source_workspace_revision !==
      inline.workspace_revision
  ) {
    throw new RetryOpfsOperation();
  }
  return inline as PreparedMigrationMarker;
}

function assertOpfsFileSet(
  marker: ActiveOpfsMarker,
  files: readonly OpfsFileRecord[],
): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (file.path_revision !== undefined) {
      assertValidStoredPathRevision(
        file.path_revision,
        marker.workspace_revision,
        file.path,
      );
    }
    if (
      file.project_id !== marker.project_id ||
      file.incarnation_id !== marker.incarnation_id ||
      file.storage_id !== marker.opfs_storage_id ||
      file.migration_id !== null ||
      normalizeFilePath(file.path) !== file.path ||
      !SHA256_CONTENT_ID_PATTERN.test(file.content_id) ||
      !Number.isSafeInteger(file.byte_size) ||
      file.byte_size < 0 ||
      paths.has(file.path)
    ) {
      throw new VfsError(
        "conflict",
        `Project filesystem manifest is invalid: ${marker.project_id}`,
      );
    }
    paths.add(file.path);
  }
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = `/${segments.slice(0, index).join("/")}`;
      if (paths.has(ancestor)) {
        throw new VfsError(
          "conflict",
          `Project filesystem manifest contains a path collision: ${ancestor}`,
        );
      }
    }
  }
}

function listEntries(
  files: readonly OpfsFileRecord[],
  normalizedPath: string,
): VfsEntry[] {
  const directory =
    normalizedPath === "/" ? "/" : `${normalizedPath}/`;
  const entries = new Map<string, VfsEntry>();
  for (const file of files) {
    if (!file.path.startsWith(directory)) continue;
    const remainder = file.path.slice(directory.length);
    if (!remainder) continue;
    const [name, ...rest] = remainder.split("/");
    if (!name) continue;
    const entryPath = `${directory}${name}`.replace("//", "/");
    entries.set(
      name,
      rest.length > 0
        ? {
            name,
            path: entryPath,
            kind: "directory",
            size: 0,
          }
        : {
            name,
            path: entryPath,
            kind: "file",
            size: file.byte_size,
          },
    );
  }
  return [...entries.values()].sort(compareVfsEntries);
}

function assertWritablePath(
  files: readonly OpfsFileRecord[],
  path: string,
): void {
  if (hasDescendants(files, path)) {
    throw new VfsError(
      "is_directory",
      `Cannot replace a directory with a file: ${path}`,
    );
  }
  const paths = new Set(files.map((file) => file.path));
  const segments = path.split("/").filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = `/${segments.slice(0, index).join("/")}`;
    if (paths.has(ancestor)) {
      throw new VfsError(
        "not_directory",
        `Cannot create a file beneath another file: ${ancestor}`,
      );
    }
  }
}

function hasDescendants(
  files: readonly OpfsFileRecord[],
  path: string,
): boolean {
  const prefix = `${path}/`;
  return files.some((file) => file.path.startsWith(prefix));
}

function hasFileAncestor(
  files: readonly OpfsFileRecord[],
  path: string,
): boolean {
  const paths = new Set(files.map((file) => file.path));
  const segments = path.split("/").filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) {
    if (paths.has(`/${segments.slice(0, index).join("/")}`)) {
      return true;
    }
  }
  return false;
}

function sameCreationBaseline(
  expected: ProjectFileSystemRecord | undefined,
  current: ProjectFileSystemRecord | undefined,
): boolean {
  if (expected === undefined || current === undefined) {
    return expected === current;
  }
  return (
    hasCompleteProjectFileSystemMetadata(current) &&
    expected.lifecycle_status === "deleted" &&
    current.lifecycle_status === "deleted" &&
    expected.incarnation_id === current.incarnation_id &&
    expected.workspace_revision === current.workspace_revision
  );
}

async function writeInitialObjects(
  objects: WorkspaceObjectStore,
  storageId: string,
  initialFiles: readonly VfsSeedFile[],
): Promise<
  Array<{
    path: string;
    content: string;
    object: WorkspaceObjectWriteResult;
  }>
> {
  const objectsByContent = new Map<string, WorkspaceObjectWriteResult>();
  const writes: Array<{
    path: string;
    content: string;
    object: WorkspaceObjectWriteResult;
  }> = [];

  for (const { path, content } of initialFiles) {
    let object = objectsByContent.get(content);
    if (object === undefined) {
      object = await objects.write(storageId, content);
      assertObjectWriteResult(object, content);
      objectsByContent.set(content, object);
    }
    writes.push({ path, content, object });
  }
  return writes;
}

function sameOpfsFile(
  left: OpfsFileRecord | undefined,
  right: OpfsFileRecord | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.project_id === right.project_id &&
    left.path === right.path &&
    left.incarnation_id === right.incarnation_id &&
    left.storage_id === right.storage_id &&
    left.content_id === right.content_id &&
    left.byte_size === right.byte_size &&
    left.migration_id === right.migration_id &&
    (normalizeStoredWorkspaceRevision(left.path_revision) ?? 0) ===
      (normalizeStoredWorkspaceRevision(right.path_revision) ?? 0)
  );
}

function sameImmutableWorkspaceChange(
  left: WorkspaceChangeRecord,
  right: WorkspaceChangeRecord,
): boolean {
  return (
    left.change_id === right.change_id &&
    left.session_id === right.session_id &&
    left.tool_call_block_id === right.tool_call_block_id &&
    left.legacy_message_id === right.legacy_message_id &&
    left.assistant_message_index === right.assistant_message_index &&
    left.tool_call_id === right.tool_call_id &&
    left.tool_name === right.tool_name &&
    left.created_at === right.created_at &&
    left.applied_workspace_revision ===
      right.applied_workspace_revision &&
    left.path === right.path &&
    left.change_kind === right.change_kind &&
    left.before_content === right.before_content &&
    left.after_content === right.after_content &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.byte_size === right.byte_size
  );
}

function assertObjectWriteResult(
  result: WorkspaceObjectWriteResult,
  content?: string,
): void {
  if (
    typeof result.content_id !== "string" ||
    !SHA256_CONTENT_ID_PATTERN.test(result.content_id) ||
    !Number.isSafeInteger(result.byte_size) ||
    result.byte_size < 0 ||
    (content !== undefined && result.byte_size !== utf8ByteSize(content))
  ) {
    throw new VfsError(
      "conflict",
      "The OPFS object store returned invalid metadata.",
    );
  }
}

function assertObjectByteSize(
  record: Pick<OpfsFileRecord, "byte_size" | "path">,
  content: string,
): void {
  if (utf8ByteSize(content) !== record.byte_size) {
    throw new VfsError(
      "conflict",
      `The OPFS object size does not match its manifest: ${record.path}`,
    );
  }
}

function utf8ByteSize(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function isOpfsCleanupRecord(
  value: unknown,
): value is OpfsCleanupRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<OpfsCleanupRecord>;
  return (
    typeof record.key === "string" &&
    record.key.startsWith(OPFS_CLEANUP_KEY_PREFIX) &&
    record.record_type === "opfs_cleanup" &&
    typeof record.created_by === "string" &&
    record.created_by.length > 0 &&
    typeof record.storage_id === "string" &&
    record.storage_id.length > 0 &&
    (record.content_id === null ||
      (typeof record.content_id === "string" &&
        SHA256_CONTENT_ID_PATTERN.test(record.content_id)))
  );
}

async function runWithNavigatorOpfsLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) return operation();
  return await lockManager.request<Promise<T>>(
    "researchbox:opfs-workspace:v1",
    () => operation(),
  );
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
  throw signal.reason ??
    new DOMException("The workspace snapshot was aborted.", "AbortError");
}
