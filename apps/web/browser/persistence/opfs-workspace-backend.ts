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

type InlineFileRecord = {
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

  create(projectId: string): Promise<Workspace> {
    return this.enqueue(async () => {
      const existing = await this.loadAndRepairMarker(projectId);
      if (existing?.lifecycle_status === "active") {
        throw new WorkspaceBackendError(
          "already_exists",
          `Project filesystem already exists: ${projectId}`,
        );
      }

      const incarnationId = crypto.randomUUID();
      const storageId = crypto.randomUUID();
      const namespaceCleanup = await this.scheduleCleanup(
        storageId,
        null,
      );
      const objectWriteResults = await Promise.allSettled(
        this.seedFiles.map(async ({ path, content }) => ({
          path,
          content,
          object: await this.objects.write(storageId, content),
        })),
      );
      const failedObjectWrite = objectWriteResults.find(
        (result) => result.status === "rejected",
      );
      if (failedObjectWrite?.status === "rejected") {
        throw failedObjectWrite.reason;
      }
      const objectWrites = objectWriteResults.map((result) => {
        if (result.status !== "fulfilled") {
          throw new Error("Unreachable rejected OPFS object write.");
        }
        return result.value;
      });

      try {
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

          const workspaceRevision = existing?.workspace_revision ?? 0;
          workspaceStore.put({
            project_id: projectId,
            incarnation_id: incarnationId,
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
    return this.enqueue(async () => {
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
        for (const change of changes) {
          changeStore.delete([projectId, change.change_id]);
        }
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

    });
  }

  private createHandle(
    projectId: string,
    incarnationId: string,
  ): Workspace {
    return {
      list: (path) =>
        this.enqueue(() =>
          this.listWorkspace(projectId, incarnationId, path),
        ),
      read: (path) =>
        this.enqueue(() =>
          this.readWorkspace(projectId, incarnationId, path),
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
      content,
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
          result,
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
      if (
        marker.workspace_revision !== snapshot.marker.workspace_revision ||
        marker.opfs_storage_id !== snapshot.marker.opfs_storage_id ||
        !sameOpfsFile(current, previous)
      ) {
        throw new RetryOpfsOperation();
      }

      if (change) {
        const changeStore = transaction.objectStore(
          databaseStores.file_changes,
        );
        const existingChange = await requestResult(
          changeStore.get([
            snapshot.marker.project_id,
            change.change_id,
          ]),
        );
        if (existingChange !== undefined) {
          throw new VfsError(
            "conflict",
            `Workspace change already exists: ${change.change_id}`,
          );
        }
        changeStore.add({
          ...change,
          project_id: snapshot.marker.project_id,
        } satisfies WorkspaceChangeStorageRecord);
      }

      const workspaceRevision = incrementWorkspaceRevision(
        marker.workspace_revision,
      );
      opfsStore.put({
        project_id: marker.project_id,
        path,
        incarnation_id: marker.incarnation_id,
        storage_id: marker.opfs_storage_id,
        content_id: object.content_id,
        byte_size: object.byte_size,
        migration_id: null,
      } satisfies OpfsFileRecord);
      transaction
        .objectStore(databaseStores.meta)
        .delete(cleanupKey);
      transaction
        .objectStore(databaseStores.project_filesystems)
        .put({
          ...marker,
          workspace_revision: workspaceRevision,
          last_change_at: change?.created_at ?? marker.last_change_at,
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

      try {
        return {
          workspace_revision: await this.commitRemove(
            snapshot,
            normalizedPath,
            existing,
          ),
        };
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
  ): Promise<number> {
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
      const marker = await readActiveOpfsMarker(
        transaction,
        snapshot.marker.project_id,
        snapshot.marker.incarnation_id,
      );
      const opfsStore = transaction.objectStore(databaseStores.opfs_files);
      const current = (await requestResult(
        opfsStore.get([snapshot.marker.project_id, path]),
      )) as OpfsFileRecord | undefined;
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
      opfsStore.delete([snapshot.marker.project_id, path]);
      transaction
        .objectStore(databaseStores.project_filesystems)
        .put({
          ...marker,
          workspace_revision: workspaceRevision,
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
      return workspaceRevision;
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
      [databaseStores.project_filesystems, databaseStores.file_changes],
      "readonly",
    );
    const completion = transactionDone(transaction);
    try {
      const marker = await readActiveOpfsMarker(
        transaction,
        projectId,
        incarnationId,
      );
      const changes = (await requestResult(
        transaction
          .objectStore(databaseStores.file_changes)
          .index("by_project")
          .getAll(projectId),
      )) as WorkspaceChangeStorageRecord[];
      await completion;
      return {
        workspace_revision: marker.workspace_revision,
        changes: changes
          .sort(compareWorkspaceChanges)
          .map(toWorkspaceChangeRecord),
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
        candidate.byte_size === utf8ByteSize(file.content)
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
            opfsFile.byte_size !== utf8ByteSize(inlineFile.content)
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
    left.migration_id === right.migration_id
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
