import {
  PROJECT_STORE_SCHEMA_VERSION,
  ProjectStoreConflictError,
  parseProjectStoreState,
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
  schema_version: typeof PROJECT_STORE_SCHEMA_VERSION;
  state_revision: number;
  active_project_id: string;
  active_session_id: string;
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
    return parseProjectStoreState({
      schema_version: catalog.schema_version,
      state_revision: catalog.state_revision,
      active_project_id: catalog.active_project_id,
      active_session_id: catalog.active_session_id,
      projects,
      sessions,
      documents,
    });
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
}
