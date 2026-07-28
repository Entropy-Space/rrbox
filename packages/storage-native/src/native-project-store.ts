import {
  ProjectStoreConflictError,
  cloneProjectStoreState,
  parseProjectStoreState,
  parseProjectStoreStateWithMigration,
  type InputDraftUpdate,
  type ProjectStore,
  type ProjectStoreChange,
  type ProjectStoreChangeListener,
  type ProjectStoreCommit,
  type ProjectStoreMutation,
  type ProjectStoreState,
} from "@researchbox/project-store";
import { NativeStorageRpcClient } from "./rpc-client.ts";

const MAX_OPTIMISTIC_ATTEMPTS = 16;

export type NativeProjectStoreOptions = {
  source_id?: string;
};

export class NativeProjectStore implements ProjectStore {
  private readonly client: NativeStorageRpcClient;
  private readonly sourceId: string;
  private readonly listeners = new Set<ProjectStoreChangeListener>();

  constructor(
    client: NativeStorageRpcClient,
    options: NativeProjectStoreOptions = {},
  ) {
    this.client = client;
    this.sourceId = options.source_id ?? crypto.randomUUID();
  }

  async load(): Promise<ProjectStoreState | null> {
    await this.client.ensureInitialized();
    for (
      let attempt = 0;
      attempt < MAX_OPTIMISTIC_ATTEMPTS;
      attempt += 1
    ) {
      const result = await this.client.request({
        kind: "project_store_load",
      });
      if (result.state === null) return null;
      const parsed = parseProjectStoreStateWithMigration(
        structuredClone(result.state),
      );
      if (!parsed.was_migrated) return parsed.state;

      const migrated: ProjectStoreState = {
        ...parsed.state,
        state_revision: parsed.state.state_revision + 1,
      };
      try {
        await this.save(migrated, parsed.state.state_revision);
        return cloneProjectStoreState(migrated);
      } catch (error) {
        if (!(error instanceof ProjectStoreConflictError)) throw error;
      }
    }
    throw new ProjectStoreConflictError(
      "The project store migration stayed busy after repeated retries.",
    );
  }

  subscribe(listener: ProjectStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async save(
    state: ProjectStoreState,
    expected_revision: number | null,
  ): Promise<void> {
    const validState = parseProjectStoreState(
      structuredClone(state),
    );
    if (
      validState.state_revision !==
      (expected_revision ?? 0) + 1
    ) {
      throw new Error(
        "Project store revisions must increase by exactly one.",
      );
    }
    await this.client.ensureInitialized();
    await this.client.request({
      kind: "project_store_save",
      state: validState,
      expected_revision,
    });
    this.publishChange(validState.state_revision);
  }

  /**
   * Native persistence spans more than one SQLite file, so mutation functions
   * are applied optimistically and may be called again after a revision
   * conflict. Callers must keep callbacks synchronous and free of external
   * side effects. Each attempt receives a new isolated clone, and retrying is
   * bounded so sustained contention is surfaced.
   */
  async mutate(
    mutation: ProjectStoreMutation,
  ): Promise<ProjectStoreCommit> {
    for (
      let attempt = 0;
      attempt < MAX_OPTIMISTIC_ATTEMPTS;
      attempt += 1
    ) {
      const current = await this.load();
      if (!current) {
        throw new Error("Project store is not initialized.");
      }
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
      try {
        await this.save(committed, current.state_revision);
        return {
          state: cloneProjectStoreState(committed),
          changed: true,
        };
      } catch (error) {
        if (!(error instanceof ProjectStoreConflictError)) throw error;
      }
    }
    throw new ProjectStoreConflictError(
      "The project store stayed busy after repeated retries.",
    );
  }

  saveInputDraft(
    update: InputDraftUpdate,
  ): Promise<ProjectStoreCommit> {
    const snapshot = { ...update };
    return this.mutate((draft) => {
      if (snapshot.session_id === null) {
        const project = draft.projects.find(
          (candidate) =>
            candidate.project_id === snapshot.project_id,
        );
        if (!project) {
          throw new Error(
            `Project ${snapshot.project_id} does not exist.`,
          );
        }
        if (project.new_chat_draft === snapshot.input_draft) return null;
        project.new_chat_draft = snapshot.input_draft;
        return draft;
      }

      const session = draft.sessions.find(
        (candidate) =>
          candidate.session_id === snapshot.session_id,
      );
      if (!session) {
        throw new Error(
          `Session ${snapshot.session_id} does not exist.`,
        );
      }
      if (session.project_id !== snapshot.project_id) {
        throw new Error(
          `Session ${snapshot.session_id} does not belong to project ${snapshot.project_id}.`,
        );
      }
      const project = draft.projects.find(
        (candidate) =>
          candidate.project_id === snapshot.project_id,
      );
      if (!project) {
        throw new Error(
          `Project ${snapshot.project_id} does not exist.`,
        );
      }
      const document = draft.documents.find(
        (candidate) =>
          candidate.session_id === snapshot.session_id,
      );
      if (!document) {
        throw new Error(
          `Session document ${snapshot.session_id} does not exist.`,
        );
      }
      if (document.project_id !== snapshot.project_id) {
        throw new Error(
          `Session document ${snapshot.session_id} does not belong to project ${snapshot.project_id}.`,
        );
      }
      if (document.input_draft === snapshot.input_draft) return null;
      document.input_draft = snapshot.input_draft;
      return draft;
    });
  }

  close(): void {
    this.listeners.clear();
  }

  private publishChange(stateRevision: number): void {
    const change: ProjectStoreChange = Object.freeze({
      source_id: this.sourceId,
      state_revision: stateRevision,
    });
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Store consumers are isolated from persistence and each other.
      }
    }
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
