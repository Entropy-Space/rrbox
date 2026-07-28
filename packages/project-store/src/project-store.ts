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
  /**
   * Applies one synchronous mutation to the latest committed state.
   *
   * Durable implementations may re-run the callback after an optimistic
   * conflict. Mutations must therefore be deterministic and side-effect-free
   * outside the provided draft.
   */
  mutate(mutation: ProjectStoreMutation): Promise<ProjectStoreCommit>;
  saveInputDraft(update: InputDraftUpdate): Promise<ProjectStoreCommit>;
  subscribe(listener: ProjectStoreChangeListener): () => void;
}

/**
 * A synchronous, retry-safe state transformation.
 *
 * Return the exact provided draft to commit it, or `null` for a no-op.
 */
export type ProjectStoreMutation = (
  draft: ProjectStoreState,
) => ProjectStoreState | null;

export type ProjectStoreCommit = {
  state: ProjectStoreState;
  changed: boolean;
};

export type ProjectStoreChange = {
  readonly source_id: string;
  readonly state_revision: number;
};

export type ProjectStoreChangeListener = (
  change: ProjectStoreChange,
) => void;

export type ProjectStoreChangeChannel = {
  postMessage(change: ProjectStoreChange): void;
  subscribe(listener: (change: unknown) => void): () => void;
  close(): void;
};

export type InputDraftUpdate = {
  project_id: string;
  session_id: string | null;
  input_draft: string;
};
