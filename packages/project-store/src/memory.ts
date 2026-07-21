import {
  ProjectStoreConflictError,
  type ProjectStore,
} from "./project-store.ts";
import {
  cloneProjectStoreState,
  parseProjectStoreState,
  type ProjectStoreState,
} from "./types.ts";

export class MemoryProjectStore implements ProjectStore {
  private state: ProjectStoreState | null;

  constructor(initialState: ProjectStoreState | null = null) {
    this.state = initialState
      ? parseProjectStoreState(cloneProjectStoreState(initialState))
      : null;
  }

  async load(): Promise<ProjectStoreState | null> {
    return this.state ? cloneProjectStoreState(this.state) : null;
  }

  async save(
    state: ProjectStoreState,
    expected_revision: number | null,
  ): Promise<void> {
    const currentRevision = this.state?.state_revision ?? null;
    if (currentRevision !== expected_revision) {
      throw new ProjectStoreConflictError();
    }
    if (state.state_revision !== (expected_revision ?? 0) + 1) {
      throw new Error("Project store revisions must increase by exactly one.");
    }
    this.state = parseProjectStoreState(cloneProjectStoreState(state));
  }
}
