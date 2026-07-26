import {
  ProjectStoreConflictError,
  type InputDraftUpdate,
  type ProjectStore,
  type ProjectStoreCommit,
  type ProjectStoreMutation,
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

  async mutate(
    mutation: ProjectStoreMutation,
  ): Promise<ProjectStoreCommit> {
    if (!this.state) throw new Error("Project store is not initialized.");
    const current = this.state;
    const draft = cloneProjectStoreState(current);
    const result = mutation(draft);
    if (isPromiseLike(result)) {
      throw new Error("Project store mutations must be synchronous.");
    }
    if (result === null) {
      return {
        state: cloneProjectStoreState(current),
        changed: false,
      };
    }
    if (result !== draft) {
      throw new Error(
        "Project store mutations must return their provided draft.",
      );
    }

    draft.state_revision = current.state_revision + 1;
    const committed = parseProjectStoreState(draft);
    this.state = committed;
    return {
      state: cloneProjectStoreState(committed),
      changed: true,
    };
  }

  async saveInputDraft(
    update: InputDraftUpdate,
  ): Promise<ProjectStoreCommit> {
    return this.mutate((draft) => {
      if (update.session_id === null) {
        const project = draft.projects.find(
          (candidate) => candidate.project_id === update.project_id,
        );
        if (!project) {
          throw new Error(`Project not found: ${update.project_id}`);
        }
        if (project.new_chat_draft === update.input_draft) return null;
        project.new_chat_draft = update.input_draft;
        return draft;
      }

      const session = draft.sessions.find(
        (candidate) => candidate.session_id === update.session_id,
      );
      if (!session || session.project_id !== update.project_id) {
        throw new Error("Draft session does not belong to the project.");
      }
      const project = draft.projects.find(
        (candidate) => candidate.project_id === update.project_id,
      );
      if (!project) throw new Error(`Project not found: ${update.project_id}`);
      const document = draft.documents.find(
        (candidate) => candidate.session_id === update.session_id,
      );
      if (!document) throw new Error("Draft session document is missing.");
      if (document.input_draft === update.input_draft) return null;
      document.input_draft = update.input_draft;
      return draft;
    });
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
