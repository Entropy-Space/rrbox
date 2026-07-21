import type { VirtualFileSystem } from "./filesystem.ts";

export interface ProjectFileSystemProvider {
  create(projectId: string): Promise<VirtualFileSystem>;
  open(projectId: string): Promise<VirtualFileSystem>;
  delete(projectId: string): Promise<void>;
}

export class MemoryProjectFileSystemProvider
  implements ProjectFileSystemProvider
{
  private readonly filesystems = new Map<string, VirtualFileSystem>();
  private readonly createFileSystem: () => VirtualFileSystem;

  constructor(createFileSystem: () => VirtualFileSystem) {
    this.createFileSystem = createFileSystem;
  }

  async create(projectId: string): Promise<VirtualFileSystem> {
    if (this.filesystems.has(projectId)) {
      throw new Error(`Project filesystem already exists: ${projectId}`);
    }
    const filesystem = this.createFileSystem();
    this.filesystems.set(projectId, filesystem);
    return filesystem;
  }

  async open(projectId: string): Promise<VirtualFileSystem> {
    const filesystem = this.filesystems.get(projectId);
    if (!filesystem) {
      throw new Error(`Project filesystem does not exist: ${projectId}`);
    }
    return filesystem;
  }

  async delete(projectId: string): Promise<void> {
    this.filesystems.delete(projectId);
  }
}
