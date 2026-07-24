import {
  snapshotWorkspaceCreateOptions,
  type Workspace,
  type WorkspaceBackend,
  type WorkspaceCreateOptions,
} from "@researchbox/vfs";
import {
  OpfsWorkspaceObjectStore,
  type WorkspaceObjectStore,
  type WorkspaceObjectStoreDirectoryHandle,
  type WorkspaceObjectStoreRootProvider,
} from "./opfs-object-store.ts";
import { OpfsWorkspaceBackend } from "./opfs-workspace-backend.ts";
import { IndexedDbWorkspaceBackend } from "./indexeddb-project-filesystem.ts";
import { ResearchBoxDatabase } from "./database.ts";

type WorkspaceObjectStoreFactory = (
  getRoot: WorkspaceObjectStoreRootProvider,
) => WorkspaceObjectStore;

class OpfsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpfsUnavailableError";
  }
}

/**
 * Selects OPFS after one successful root probe and otherwise retains the
 * IndexedDB content backend. Once selected, operational failures are surfaced
 * instead of silently switching stores and exposing stale content.
 */
export class BrowserWorkspaceBackend implements WorkspaceBackend {
  private readonly database: ResearchBoxDatabase;
  private readonly seedFiles: Record<string, string>;
  private readonly getOpfsRoot: WorkspaceObjectStoreRootProvider;
  private readonly createObjectStore: WorkspaceObjectStoreFactory;
  private backendPromise: Promise<WorkspaceBackend> | null = null;

  constructor(
    database: ResearchBoxDatabase,
    seedFiles: Record<string, string>,
    getOpfsRoot: WorkspaceObjectStoreRootProvider = getNavigatorOpfsRoot,
    createObjectStore: WorkspaceObjectStoreFactory = (getRoot) =>
      new OpfsWorkspaceObjectStore(getRoot),
  ) {
    this.database = database;
    this.seedFiles = seedFiles;
    this.getOpfsRoot = getOpfsRoot;
    this.createObjectStore = createObjectStore;
  }

  async create(
    projectId: string,
    options?: WorkspaceCreateOptions,
  ): Promise<Workspace> {
    const createOptions = snapshotWorkspaceCreateOptions(options);
    return (await this.getBackend()).create(projectId, createOptions);
  }

  async open(projectId: string): Promise<Workspace> {
    return (await this.getBackend()).open(projectId);
  }

  async delete(projectId: string): Promise<void> {
    return (await this.getBackend()).delete(projectId);
  }

  private getBackend(): Promise<WorkspaceBackend> {
    const existing = this.backendPromise;
    if (existing) return existing;
    const selection = this.selectBackend();
    this.backendPromise = selection;
    void selection.catch(() => {
      if (this.backendPromise === selection) {
        this.backendPromise = null;
      }
    });
    return selection;
  }

  private async selectBackend(): Promise<WorkspaceBackend> {
    let root: WorkspaceObjectStoreDirectoryHandle;
    try {
      root = await this.getOpfsRoot();
      await probeWritableOpfs(root);
    } catch (error) {
      if (isOpfsUnavailable(error)) {
        return new IndexedDbWorkspaceBackend(
          this.database,
          this.seedFiles,
        );
      }
      throw error;
    }
    const getRoot = async () => root;
    return new OpfsWorkspaceBackend(
      this.database,
      this.createObjectStore(getRoot),
      this.seedFiles,
    );
  }
}

async function getNavigatorOpfsRoot(): Promise<
  WorkspaceObjectStoreDirectoryHandle
> {
  const storage = navigator.storage as
    | (StorageManager & {
        getDirectory?: () => Promise<FileSystemDirectoryHandle>;
      })
    | undefined;
  if (typeof storage?.getDirectory !== "function") {
    throw new OpfsUnavailableError(
      "OPFS is unavailable in this browser.",
    );
  }
  return storage.getDirectory();
}

async function probeWritableOpfs(
  root: WorkspaceObjectStoreDirectoryHandle,
): Promise<void> {
  const probeName = `researchbox-opfs-probe-${crypto.randomUUID()}`;
  let writable:
    | Awaited<ReturnType<
        Awaited<ReturnType<typeof root.getFileHandle>>["createWritable"]
      >>
    | undefined;
  try {
    const file = await root.getFileHandle(probeName, { create: true });
    if (typeof file.createWritable !== "function") {
      throw new OpfsUnavailableError(
        "OPFS writable streams are unavailable in this browser.",
      );
    }
    writable = await file.createWritable();
    await writable.write(new Uint8Array());
    await writable.close();
  } catch (error) {
    await writable?.abort?.(error).catch(() => undefined);
    throw error;
  } finally {
    await root.removeEntry(probeName).catch(() => undefined);
  }
}

function isOpfsUnavailable(error: unknown): boolean {
  if (error instanceof OpfsUnavailableError) return true;
  if (!(error instanceof DOMException)) return false;
  return (
    error.name === "NotSupportedError" ||
    error.name === "SecurityError" ||
    error.name === "NotAllowedError"
  );
}
