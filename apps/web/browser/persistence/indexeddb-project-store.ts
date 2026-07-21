import {
  PROJECT_STORE_SCHEMA_VERSION,
  ProjectStoreConflictError,
  parseProjectStoreState,
  parseProjectStoreStateWithMigration,
  type InputDraftUpdate,
  type ProjectRecord,
  type ProjectStore,
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

export class IndexedDbProjectStore implements ProjectStore {
  private readonly database: ResearchBoxDatabase;

  constructor(database: ResearchBoxDatabase) {
    this.database = database;
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
      await Promise.all([
        requestResult(projectStore.clear()),
        requestResult(sessionStore.clear()),
        requestResult(documentStore.clear()),
      ]);

      for (const project of validState.projects) projectStore.put(project);
      for (const session of validState.sessions) sessionStore.put(session);
      for (const document of validState.documents) documentStore.put(document);
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
  }

  async saveInputDraft(update: InputDraftUpdate): Promise<void> {
    if (update.session_id === null) {
      await this.saveNewChatDraft(update);
      return;
    }
    await this.saveSessionDraft({
      ...update,
      session_id: update.session_id,
    });
  }

  private async saveNewChatDraft(update: InputDraftUpdate): Promise<void> {
    const database = await this.database.open();
    const transaction = database.transaction(
      databaseStores.projects,
      "readwrite",
    );
    const completion = transactionDone(transaction);

    try {
      const projectStore = transaction.objectStore(databaseStores.projects);
      const project = (await requestResult(
        projectStore.get(update.project_id),
      )) as ProjectRecord | undefined;
      if (!project) {
        throw new Error(`Project ${update.project_id} does not exist.`);
      }
      projectStore.put({
        ...project,
        new_chat_draft: update.input_draft,
      } satisfies ProjectRecord);
    } catch (error) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw error;
    }

    await completion;
  }

  private async saveSessionDraft(
    update: InputDraftUpdate & { session_id: string },
  ): Promise<void> {
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.projects,
        databaseStores.sessions,
        databaseStores.session_documents,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);

    try {
      const projectStore = transaction.objectStore(databaseStores.projects);
      const sessionStore = transaction.objectStore(databaseStores.sessions);
      const documentStore = transaction.objectStore(
        databaseStores.session_documents,
      );
      const [project, session, document] = await Promise.all([
        requestResult(projectStore.get(update.project_id)) as Promise<
          ProjectRecord | undefined
        >,
        requestResult(sessionStore.get(update.session_id)) as Promise<
          SessionRecord | undefined
        >,
        requestResult(documentStore.get(update.session_id)) as Promise<
          SessionDocument | undefined
        >,
      ]);
      if (!session) {
        throw new Error(`Session ${update.session_id} does not exist.`);
      }
      if (session.project_id !== update.project_id) {
        throw new Error(
          `Session ${update.session_id} does not belong to project ${update.project_id}.`,
        );
      }
      if (!project) {
        throw new Error(`Project ${update.project_id} does not exist.`);
      }
      if (!document) {
        throw new Error(`Session document ${update.session_id} does not exist.`);
      }
      if (document.project_id !== update.project_id) {
        throw new Error(
          `Session document ${update.session_id} does not belong to project ${update.project_id}.`,
        );
      }
      documentStore.put({
        ...document,
        input_draft: update.input_draft,
      } satisfies SessionDocument);
    } catch (error) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw error;
    }

    await completion;
  }
}
