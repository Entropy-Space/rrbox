import {
  PROJECT_STORE_SCHEMA_VERSION,
  ProjectStoreConflictError,
  cloneProjectStoreState,
  parseProjectStoreState,
  parseProjectStoreStateWithMigration,
  type InputDraftUpdate,
  type ProjectRecord,
  type ProjectStore,
  type ProjectStoreChange,
  type ProjectStoreChangeChannel,
  type ProjectStoreChangeListener,
  type ProjectStoreCommit,
  type ProjectStoreMutation,
  type ProjectStoreState,
  type SessionDocument,
  type SessionRecord,
} from "@researchbox/project-store";
import {
  databaseStores,
  requestResult,
  ResearchBoxDatabase,
  transactionDone,
} from "./database.ts";

type CatalogRecord = {
  key: "catalog";
  schema_version: 1 | 2 | typeof PROJECT_STORE_SCHEMA_VERSION;
  state_revision: number;
  active_project_id: string;
  active_session_id: string | null;
};

export type IndexedDbProjectStoreOptions = {
  change_channel?: ProjectStoreChangeChannel | null;
  source_id?: string;
};

export class IndexedDbProjectStore implements ProjectStore {
  private readonly database: ResearchBoxDatabase;
  private readonly sourceId: string;
  private readonly changeChannel: ProjectStoreChangeChannel | null;
  private readonly listeners = new Set<ProjectStoreChangeListener>();
  private readonly unsubscribeChannel: (() => void) | null;

  constructor(
    database: ResearchBoxDatabase,
    options: IndexedDbProjectStoreOptions = {},
  ) {
    this.database = database;
    this.sourceId = options.source_id ?? crypto.randomUUID();
    this.changeChannel =
      options.change_channel === undefined
        ? createDefaultChangeChannel()
        : options.change_channel;
    this.unsubscribeChannel =
      this.changeChannel?.subscribe((change) =>
        this.receiveChange(change),
      ) ?? null;
  }

  async load(): Promise<ProjectStoreState | null> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.meta,
        databaseStores.projects,
        databaseStores.sessions,
        databaseStores.session_documents,
      ],
      "readonly",
    );
    const completion = transactionDone(transaction);
    const [catalog, projects, sessions, documents] = await Promise.all([
      requestResult(
        transaction.objectStore(databaseStores.meta).get("catalog"),
      ) as Promise<CatalogRecord | undefined>,
      requestResult(
        transaction.objectStore(databaseStores.projects).getAll(),
      ) as Promise<ProjectRecord[]>,
      requestResult(
        transaction.objectStore(databaseStores.sessions).getAll(),
      ) as Promise<SessionRecord[]>,
      requestResult(
        transaction.objectStore(databaseStores.session_documents).getAll(),
      ) as Promise<SessionDocument[]>,
    ]);
    await completion;
    if (!catalog) return null;
    const parsed = parseProjectStoreStateWithMigration({
      schema_version: catalog.schema_version,
      state_revision: catalog.state_revision,
      active_project_id: catalog.active_project_id,
      active_session_id: catalog.active_session_id,
      projects,
      sessions,
      documents,
    });
    if (!parsed.was_migrated) return parsed.state;

    const migratedState: ProjectStoreState = {
      ...parsed.state,
      state_revision: parsed.state.state_revision + 1,
    };
    await this.save(migratedState, parsed.state.state_revision);
    return migratedState;
  }

  subscribe(listener: ProjectStoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unsubscribeChannel?.();
    this.changeChannel?.close();
    this.listeners.clear();
  }

  async save(
    state: ProjectStoreState,
    expected_revision: number | null,
  ): Promise<void> {
    const validState = parseProjectStoreState(state);
    if (validState.state_revision !== (expected_revision ?? 0) + 1) {
      throw new Error("Project store revisions must increase by exactly one.");
    }

    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.meta,
        databaseStores.projects,
        databaseStores.sessions,
        databaseStores.session_documents,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);

    try {
      const metaStore = transaction.objectStore(databaseStores.meta);
      const existing = (await requestResult(
        metaStore.get("catalog"),
      )) as CatalogRecord | undefined;
      if ((existing?.state_revision ?? null) !== expected_revision) {
        throw new ProjectStoreConflictError();
      }

      const projectStore = transaction.objectStore(databaseStores.projects);
      const sessionStore = transaction.objectStore(databaseStores.sessions);
      const documentStore = transaction.objectStore(
        databaseStores.session_documents,
      );
      const [projects, sessions, documents] = await Promise.all([
        requestResult(projectStore.getAll()) as Promise<ProjectRecord[]>,
        requestResult(sessionStore.getAll()) as Promise<SessionRecord[]>,
        requestResult(documentStore.getAll()) as Promise<SessionDocument[]>,
      ]);
      synchronizeRecords(
        projectStore,
        projects,
        validState.projects,
        (project) => project.project_id,
      );
      synchronizeRecords(
        sessionStore,
        sessions,
        validState.sessions,
        (session) => session.session_id,
      );
      synchronizeRecords(
        documentStore,
        documents,
        validState.documents,
        (document) => document.session_id,
      );
      metaStore.put({
        key: "catalog",
        schema_version: PROJECT_STORE_SCHEMA_VERSION,
        state_revision: validState.state_revision,
        active_project_id: validState.active_project_id,
        active_session_id: validState.active_session_id,
      } satisfies CatalogRecord);
    } catch (error) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw error;
    }

    await completion;
    this.publishChange(validState.state_revision);
  }

  async mutate(
    mutation: ProjectStoreMutation,
  ): Promise<ProjectStoreCommit> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.meta,
        databaseStores.projects,
        databaseStores.sessions,
        databaseStores.session_documents,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);

    try {
      const metaStore = transaction.objectStore(databaseStores.meta);
      const projectStore = transaction.objectStore(databaseStores.projects);
      const sessionStore = transaction.objectStore(databaseStores.sessions);
      const documentStore = transaction.objectStore(
        databaseStores.session_documents,
      );
      const [catalog, projects, sessions, documents] = await Promise.all([
        requestResult(metaStore.get("catalog")) as Promise<
          CatalogRecord | undefined
        >,
        requestResult(projectStore.getAll()) as Promise<ProjectRecord[]>,
        requestResult(sessionStore.getAll()) as Promise<SessionRecord[]>,
        requestResult(documentStore.getAll()) as Promise<SessionDocument[]>,
      ]);
      if (!catalog) {
        throw new Error("Project store is not initialized.");
      }

      const current = parseProjectStoreState({
        schema_version: catalog.schema_version,
        state_revision: catalog.state_revision,
        active_project_id: catalog.active_project_id,
        active_session_id: catalog.active_session_id,
        projects,
        sessions,
        documents,
      });
      const draft = cloneProjectStoreState(current);
      const result = mutation(draft);
      if (isPromiseLike(result)) {
        throw new Error("Project store mutations must be synchronous.");
      }
      if (result === null) {
        await completion;
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
      synchronizeRecords(
        projectStore,
        projects,
        committed.projects,
        (project) => project.project_id,
      );
      synchronizeRecords(
        sessionStore,
        sessions,
        committed.sessions,
        (session) => session.session_id,
      );
      synchronizeRecords(
        documentStore,
        documents,
        committed.documents,
        (document) => document.session_id,
      );
      metaStore.put({
        key: "catalog",
        schema_version: PROJECT_STORE_SCHEMA_VERSION,
        state_revision: committed.state_revision,
        active_project_id: committed.active_project_id,
        active_session_id: committed.active_session_id,
      } satisfies CatalogRecord);
      await completion;
      this.publishChange(committed.state_revision);
      return {
        state: cloneProjectStoreState(committed),
        changed: true,
      };
    } catch (error) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw error;
    }
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
          throw new Error(`Project ${update.project_id} does not exist.`);
        }
        if (project.new_chat_draft === update.input_draft) return null;
        project.new_chat_draft = update.input_draft;
        return draft;
      }

      const session = draft.sessions.find(
        (candidate) => candidate.session_id === update.session_id,
      );
      if (!session) {
        throw new Error(`Session ${update.session_id} does not exist.`);
      }
      if (session.project_id !== update.project_id) {
        throw new Error(
          `Session ${update.session_id} does not belong to project ${update.project_id}.`,
        );
      }
      const project = draft.projects.find(
        (candidate) => candidate.project_id === update.project_id,
      );
      if (!project) {
        throw new Error(`Project ${update.project_id} does not exist.`);
      }
      const document = draft.documents.find(
        (candidate) => candidate.session_id === update.session_id,
      );
      if (!document) {
        throw new Error(
          `Session document ${update.session_id} does not exist.`,
        );
      }
      if (document.project_id !== update.project_id) {
        throw new Error(
          `Session document ${update.session_id} does not belong to project ${update.project_id}.`,
        );
      }
      if (document.input_draft === update.input_draft) return null;
      document.input_draft = update.input_draft;
      return draft;
    });
  }

  private publishChange(stateRevision: number): void {
    const change: ProjectStoreChange = Object.freeze({
      source_id: this.sourceId,
      state_revision: stateRevision,
    });
    this.notifyListeners(change);
    try {
      this.changeChannel?.postMessage(change);
    } catch {
      // A committed write must not fail because cross-context delivery failed.
    }
  }

  private receiveChange(value: unknown): void {
    const change = parseProjectStoreChange(value);
    if (!change || change.source_id === this.sourceId) return;
    this.notifyListeners(change);
  }

  private notifyListeners(change: ProjectStoreChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Store consumers are isolated from persistence and each other.
      }
    }
  }
}

const PROJECT_STORE_CHANGE_CHANNEL =
  "researchbox:project-store-changes:v1";

function createDefaultChangeChannel(): ProjectStoreChangeChannel | null {
  if (
    typeof globalThis.BroadcastChannel !== "function" ||
    !("location" in globalThis)
  ) {
    return null;
  }

  const channel = new globalThis.BroadcastChannel(
    PROJECT_STORE_CHANGE_CHANNEL,
  );
  return {
    postMessage(change) {
      channel.postMessage(change);
    },
    subscribe(listener) {
      const handleMessage = (event: MessageEvent<unknown>) => {
        listener(event.data);
      };
      channel.addEventListener("message", handleMessage);
      return () => channel.removeEventListener("message", handleMessage);
    },
    close() {
      channel.close();
    },
  };
}

function parseProjectStoreChange(
  value: unknown,
): ProjectStoreChange | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("source_id" in value) ||
    typeof value.source_id !== "string" ||
    value.source_id.length === 0 ||
    !("state_revision" in value) ||
    typeof value.state_revision !== "number" ||
    !Number.isSafeInteger(value.state_revision) ||
    value.state_revision < 0
  ) {
    return null;
  }
  return Object.freeze({
    source_id: value.source_id,
    state_revision: value.state_revision,
  });
}

function synchronizeRecords<T>(
  store: IDBObjectStore,
  current: readonly T[],
  next: readonly T[],
  keyOf: (record: T) => string,
): void {
  const currentById = new Map(
    current.map((record) => [keyOf(record), record]),
  );
  const nextById = new Map(next.map((record) => [keyOf(record), record]));

  for (const key of currentById.keys()) {
    if (!nextById.has(key)) store.delete(key);
  }
  for (const [key, record] of nextById) {
    const existing = currentById.get(key);
    if (existing === undefined || !sameRecord(existing, record)) {
      store.put(record);
    }
  }
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
