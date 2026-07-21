import type { ProjectStoreState } from "./types.ts";

export class ProjectStoreConflictError extends Error {
  constructor(message = "The project store was changed by another writer.") {
    super(message);
    this.name = "ProjectStoreConflictError";
  }
}

export interface ProjectStore {
  load(): Promise<ProjectStoreState | null>;
  save(
    state: ProjectStoreState,
    expected_revision: number | null,
  ): Promise<void>;
}
