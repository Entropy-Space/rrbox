import { Context } from "@deepseek-ai/cordis";
import {
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionPreparation,
} from "@deepseek-ai/dsh-session";
import SessionPersistence, {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence";
import type {
  JsonValue,
  ProjectStore,
  SessionDocument,
} from "@researchbox/project-store";

export const DSHRBOX_RUNTIME_ID = "dsh";
export const DSHRBOX_RUNTIME_STATE_FORMAT_VERSION = 1;

export type DshrboxSessionPersistenceConfig = {
  project_store: ProjectStore;
  prepared_session_cache_size?: number;
  write_batch_max_delay_ms?: number;
};

type PersistedDshSession = {
  source_id: string;
  revision: number;
  header: SessionHeader;
  events: SessionEvent[];
};

export type DshrboxPersistedSessionSnapshot = {
  header: SessionHeader;
  events: SessionEvent[];
};

/** Read and validate the DSH-owned portion of one marked session document. */
export function readDshrboxPersistedSession(
  document: SessionDocument,
): DshrboxPersistedSessionSnapshot | null {
  if (document.runtime_state?.runtime_id !== DSHRBOX_RUNTIME_ID) {
    throw new Error(`Session ${document.session_id} is not owned by DSH.`);
  }
  const persisted = parsePersistedSession(document);
  return persisted === undefined
    ? null
    : {
        header: structuredClone(persisted.header),
        events: structuredClone(persisted.events),
      };
}

/** DSH persistence service backed by the existing rrbox ProjectStore. */
export class DshrboxSessionPersistence extends SessionPersistence {
  static inject = ["sessions"];

  readonly supportsRawArtifacts = false;

  private readonly backend: ProjectStorePersistenceBackend;
  private readonly coordinator: PersistenceCoordinator;

  constructor(ctx: Context, config: DshrboxSessionPersistenceConfig) {
    assertConfig(config);
    super(ctx);
    this.backend = new ProjectStorePersistenceBackend(config.project_store);
    this.coordinator = new PersistenceCoordinator(ctx, this.backend, {
      preparedSessionCacheSize:
        config.prepared_session_cache_size ??
        DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs:
        config.write_batch_max_delay_ms ??
        DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    });
  }

  locate(): SessionLocation | undefined {
    return undefined;
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta);
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal);
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id);
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal);
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.backend.list(signal);
  }

  async listSnapshots(
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshot[]> {
    const headers = await this.backend.list(signal);
    return Promise.all(headers.map(async (header) => {
      const revision = await this.backend.readStoredRevision(
        header.id,
        signal,
      );
      if (revision === undefined) {
        throw new Error(`Persisted DSH session disappeared: ${header.id}.`);
      }
      return { header, revision };
    }));
  }
}

export default DshrboxSessionPersistence;

class ProjectStorePersistenceBackend implements PersistenceBackend {
  readonly name = "rrbox project store";

  private readonly projectStore: ProjectStore;
  private readonly sourceId = crypto.randomUUID();

  constructor(projectStore: ProjectStore) {
    this.projectStore = projectStore;
  }

  async loadStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix | undefined> {
    throwIfAborted(signal);
    const state = await this.projectStore.load();
    throwIfAborted(signal);
    if (state === null) return undefined;
    const document = state.documents.find(
      (candidate) => candidate.session_id === String(id),
    );
    if (document === undefined) return undefined;
    const persisted = parsePersistedSession(document);
    if (persisted === undefined) return undefined;
    return {
      meta: structuredClone(persisted.header),
      events: structuredClone(persisted.events),
      revision: persistenceRevision(persisted),
    };
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    throwIfAborted(signal);
    const state = await this.projectStore.load();
    throwIfAborted(signal);
    if (state === null) return undefined;
    const document = state.documents.find(
      (candidate) => candidate.session_id === String(id),
    );
    if (document === undefined) return undefined;
    const persisted = parsePersistedSession(document);
    return persisted === undefined
      ? undefined
      : persistenceRevision(persisted);
  }

  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    if (events.length === 0) return;
    const header = structuredClone(meta);
    const batch = structuredClone(events);
    const sourceId = this.sourceId;
    await this.projectStore.mutate((draft) => {
      const document = requireDshDocument(draft.documents, String(meta.id));
      const current = parsePersistedSession(document);
      if (isMaterialized !== (current !== undefined)) {
        throw new Error(
          `DSH session materialization changed for ${meta.id}.`,
        );
      }
      const expectedSeq = current?.events.length ?? 0;
      assertBatchStartsAt(batch, expectedSeq);
      if (
        current !== undefined &&
        JSON.stringify(current.header) !== JSON.stringify(header)
      ) {
        throw new Error(`DSH session header changed for ${meta.id}.`);
      }
      writePersistedSession(document, {
        source_id: current?.source_id ?? sourceId,
        revision: (current?.revision ?? 0) + 1,
        header: current?.header ?? header,
        events: [...(current?.events ?? []), ...batch],
      });
      return draft;
    });
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: unknown,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (tornMarker !== undefined) {
      throw new Error("The atomic rrbox project store cannot have a torn tail.");
    }
    if (closers.length === 0) return;
    const batch = structuredClone(closers);
    await this.projectStore.mutate((draft) => {
      const document = requireDshDocument(draft.documents, String(meta.id));
      const current = parsePersistedSession(document);
      if (current === undefined) {
        throw new Error(`Cannot repair missing DSH session ${meta.id}.`);
      }
      assertBatchStartsAt(batch, current.events.length);
      writePersistedSession(document, {
        ...current,
        revision: current.revision + 1,
        events: [...current.events, ...batch],
      });
      return draft;
    });
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    throwIfAborted(signal);
    const state = await this.projectStore.load();
    throwIfAborted(signal);
    if (state === null) return [];
    const headers: SessionHeader[] = [];
    for (const document of state.documents) {
      const persisted = parsePersistedSession(document);
      if (persisted !== undefined) {
        headers.push(structuredClone(persisted.header));
      }
    }
    return headers;
  }
}

function assertConfig(
  config: DshrboxSessionPersistenceConfig,
): void {
  if (
    config === null ||
    typeof config !== "object" ||
    config.project_store === null ||
    typeof config.project_store !== "object" ||
    typeof config.project_store.load !== "function" ||
    typeof config.project_store.mutate !== "function"
  ) {
    throw new TypeError(
      "dshrbox session persistence requires a project_store",
    );
  }
}

function requireDshDocument(
  documents: SessionDocument[],
  sessionId: string,
): SessionDocument {
  const document = documents.find(
    (candidate) => candidate.session_id === sessionId,
  );
  if (document === undefined) {
    throw new Error(`Session document not found: ${sessionId}.`);
  }
  if (document.runtime_state?.runtime_id !== DSHRBOX_RUNTIME_ID) {
    throw new Error(`Session ${sessionId} is not owned by DSH.`);
  }
  return document;
}

function parsePersistedSession(
  document: SessionDocument,
): PersistedDshSession | undefined {
  const runtimeState = document.runtime_state;
  if (runtimeState?.runtime_id !== DSHRBOX_RUNTIME_ID) return undefined;
  if (
    runtimeState.format_version !== DSHRBOX_RUNTIME_STATE_FORMAT_VERSION
  ) {
    throw new Error(
      `Unsupported dshrbox runtime state version: ${runtimeState.format_version}.`,
    );
  }
  if (runtimeState.payload === null) return undefined;
  const payload = runtimeState.payload;
  if (
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.source_id !== "string" ||
    payload.source_id.length === 0 ||
    typeof payload.revision !== "number" ||
    !Number.isSafeInteger(payload.revision) ||
    payload.revision < 1 ||
    typeof payload.header !== "object" ||
    payload.header === null ||
    Array.isArray(payload.header) ||
    !Array.isArray(payload.events)
  ) {
    throw new Error(`Invalid persisted DSH session: ${document.session_id}.`);
  }
  return structuredClone(payload) as unknown as PersistedDshSession;
}

function writePersistedSession(
  document: SessionDocument,
  persisted: PersistedDshSession,
): void {
  document.runtime_state = {
    runtime_id: DSHRBOX_RUNTIME_ID,
    format_version: DSHRBOX_RUNTIME_STATE_FORMAT_VERSION,
    payload: structuredClone(persisted) as unknown as JsonValue,
  };
}

function persistenceRevision(
  persisted: PersistedDshSession,
): ReturnType<typeof SessionPersistenceRevision> {
  return SessionPersistenceRevision(
    `${persisted.source_id}:${persisted.revision}`,
  );
}

function assertBatchStartsAt(
  events: readonly SessionEvent[],
  expectedSeq: number,
): void {
  for (const [index, event] of events.entries()) {
    const expected = expectedSeq + index;
    if (event.seq !== expected) {
      throw new Error(
        `DSH event seq ${event.seq} does not match stored seq ${expected}.`,
      );
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Operation aborted.", "AbortError");
}
