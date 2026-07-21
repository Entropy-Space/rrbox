import {
  ProjectStoreConflictError,
  type InputDraftUpdate,
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

  async saveInputDraft(update: InputDraftUpdate): Promise<void> {
    if (!this.state) throw new Error("Project store is not initialized.");
    const next = cloneProjectStoreState(this.state);
    const project = next.projects.find(
      (candidate) => candidate.project_id === update.project_id,
    );
    if (!project) throw new Error(`Project not found: ${update.project_id}`);

    if (update.session_id === null) {
      project.new_chat_draft = update.input_draft;
    } else {
      const session = next.sessions.find(
        (candidate) => candidate.session_id === update.session_id,
      );
      if (!session || session.project_id !== update.project_id) {
        throw new Error("Draft session does not belong to the project.");
      }
      const document = next.documents.find(
        (candidate) => candidate.session_id === update.session_id,
      );
      if (!document) throw new Error("Draft session document is missing.");
      document.input_draft = update.input_draft;
    }

    this.state = parseProjectStoreState(next);
  }
}
