export type WorkspaceObjectWriteResult = {
  content_id: string;
  byte_size: number;
};

export interface WorkspaceObjectStore {
  identify(content: string): Promise<WorkspaceObjectWriteResult>;
  write(
    storageId: string,
    content: string,
  ): Promise<WorkspaceObjectWriteResult>;
  read(storageId: string, contentId: string): Promise<string>;
  deleteObject(storageId: string, contentId: string): Promise<void>;
  deleteStorage(storageId: string): Promise<void>;
}

type ObjectStoreFile = {
  arrayBuffer(): Promise<ArrayBuffer>;
};

type ObjectStoreWritable = {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};

type ObjectStoreFileHandle = {
  getFile(): Promise<ObjectStoreFile>;
  createWritable(): Promise<ObjectStoreWritable>;
};

export type WorkspaceObjectStoreDirectoryHandle = {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<WorkspaceObjectStoreDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<ObjectStoreFileHandle>;
  removeEntry(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
};

export type WorkspaceObjectStoreRootProvider =
  () => Promise<WorkspaceObjectStoreDirectoryHandle>;

export class WorkspaceObjectIntegrityError extends Error {
  readonly expected_content_id: string;
  readonly actual_content_id: string;

  constructor(expectedContentId: string, actualContentId: string) {
    super(
      `Workspace object integrity check failed: expected ${expectedContentId}, received ${actualContentId}`,
    );
    this.name = "WorkspaceObjectIntegrityError";
    this.expected_content_id = expectedContentId;
    this.actual_content_id = actualContentId;
  }
}

const contentIdPattern = /^[0-9a-f]{64}$/;
const storageDirectoryPrefix = "workspace-";

export class OpfsWorkspaceObjectStore implements WorkspaceObjectStore {
  private readonly getRoot: WorkspaceObjectStoreRootProvider;

  constructor(
    getRoot: WorkspaceObjectStoreRootProvider = () =>
      navigator.storage.getDirectory(),
  ) {
    this.getRoot = getRoot;
  }

  async identify(content: string): Promise<WorkspaceObjectWriteResult> {
    const contentBytes = new TextEncoder().encode(content);
    return {
      content_id: await sha256Hex(contentBytes),
      byte_size: contentBytes.byteLength,
    };
  }

  async write(
    storageId: string,
    content: string,
  ): Promise<WorkspaceObjectWriteResult> {
    const contentBytes = new TextEncoder().encode(content);
    const identified = await this.identify(content);
    const contentId = identified.content_id;
    const directory = await this.getStorageDirectory(storageId, true);
    const existingBytes = await readObjectBytesIfPresent(directory, contentId);

    if (
      existingBytes !== null &&
      await sha256Hex(existingBytes) === contentId
    ) {
      return {
        content_id: contentId,
        byte_size: identified.byte_size,
      };
    }

    const fileHandle = await directory.getFileHandle(contentId, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(contentBytes);
      await writable.close();
    } catch (error) {
      await writable.abort?.(error).catch(() => undefined);
      throw error;
    }

    return {
      content_id: contentId,
      byte_size: identified.byte_size,
    };
  }

  async read(storageId: string, contentId: string): Promise<string> {
    assertContentId(contentId);
    const directory = await this.getStorageDirectory(storageId, false);
    const fileHandle = await directory.getFileHandle(contentId);
    const contentBytes = await readFileBytes(fileHandle);
    const actualContentId = await sha256Hex(contentBytes);

    if (actualContentId !== contentId) {
      throw new WorkspaceObjectIntegrityError(contentId, actualContentId);
    }

    return new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
  }

  async deleteObject(
    storageId: string,
    contentId: string,
  ): Promise<void> {
    assertContentId(contentId);
    try {
      const directory = await this.getStorageDirectory(storageId, false);
      await directory.removeEntry(contentId);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  async deleteStorage(storageId: string): Promise<void> {
    const root = await this.getRoot();
    const directoryName = await storageDirectoryName(storageId);

    try {
      await root.removeEntry(directoryName, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
  }

  private async getStorageDirectory(
    storageId: string,
    create: boolean,
  ): Promise<WorkspaceObjectStoreDirectoryHandle> {
    const root = await this.getRoot();
    return root.getDirectoryHandle(
      await storageDirectoryName(storageId),
      { create },
    );
  }
}

async function readObjectBytesIfPresent(
  directory: WorkspaceObjectStoreDirectoryHandle,
  contentId: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return await readFileBytes(await directory.getFileHandle(contentId));
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function readFileBytes(
  fileHandle: ObjectStoreFileHandle,
): Promise<Uint8Array<ArrayBuffer>> {
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function storageDirectoryName(storageId: string): Promise<string> {
  const storageIdBytes = new TextEncoder().encode(storageId);
  return `${storageDirectoryPrefix}${await sha256Hex(storageIdBytes)}`;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function assertContentId(contentId: string): void {
  if (!contentIdPattern.test(contentId)) {
    throw new TypeError(`Invalid workspace object content ID: ${contentId}`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotFoundError"
  );
}
