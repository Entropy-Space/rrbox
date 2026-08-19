import type {
  SessionEvent,
  SessionHeader,
  SessionId,
} from "@deepseek-ai/dsh-session";
import {
  SessionPersistenceRevision,
  type StoredPrefix,
  type StoredSuffix,
} from "@deepseek-ai/dsh-session-persistence";
import type { DshrboxSessionBackend } from "@dshrbox/session-persistence";
import {
  databaseStores,
  requestResult,
  ResearchBoxDatabase,
  transactionDone,
} from "@researchbox/storage-browser";

type SessionHeaderRecord = {
  session_id: string;
  header: SessionHeader;
  storage_id: string;
  revision: number;
  event_count: number;
};

type SessionEventRecord = {
  session_id: string;
  seq: number;
  event: SessionEvent;
};

export class DshrboxBrowserSessionStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshrboxBrowserSessionStorageError";
  }
}

/** IndexedDB implementation of DSH's canonical persistence primitives. */
export class IndexedDbDshrboxSessionBackend
  implements DshrboxSessionBackend {
  readonly name = "dshrbox IndexedDB";

  private readonly database: ResearchBoxDatabase;

  constructor(database: ResearchBoxDatabase) {
    this.database = database;
  }

  async loadStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix | undefined> {
    throwIfAborted(signal);
    const sessionId = String(id);
    const database = await this.database.open();
    throwIfAborted(signal);
    const transaction = database.transaction(
      [
        databaseStores.dsh_session_headers,
        databaseStores.dsh_session_events,
      ],
      "readonly",
    );
    const completion = transactionDone(transaction);
    const [header, eventRecords] = await Promise.all([
      requestResult(
        transaction.objectStore(databaseStores.dsh_session_headers)
          .get(sessionId),
      ) as Promise<SessionHeaderRecord | undefined>,
      requestResult(
        transaction.objectStore(databaseStores.dsh_session_events)
          .getAll(sessionEventRange(sessionId, 0)),
      ) as Promise<SessionEventRecord[]>,
    ]);
    await completion;
    throwIfAborted(signal);
    if (header === undefined) {
      if (eventRecords.length > 0) {
        throw storageError(sessionId, "has events without a header");
      }
      return undefined;
    }
    validateHeaderRecord(header, sessionId);
    const events = validateEventRecords(
      eventRecords,
      sessionId,
      0,
      header.event_count,
    );
    return {
      meta: header.header,
      events,
      revision: revisionOf(header),
    };
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    throwIfAborted(signal);
    const sessionId = String(id);
    const database = await this.database.open();
    throwIfAborted(signal);
    const transaction = database.transaction(
      databaseStores.dsh_session_headers,
      "readonly",
    );
    const completion = transactionDone(transaction);
    const header = await requestResult(
      transaction.objectStore(databaseStores.dsh_session_headers)
        .get(sessionId),
    ) as SessionHeaderRecord | undefined;
    await completion;
    throwIfAborted(signal);
    if (header === undefined) return undefined;
    validateHeaderRecord(header, sessionId);
    return revisionOf(header);
  }

  async loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    throwIfAborted(signal);
    const sessionId = String(id);
    const database = await this.database.open();
    throwIfAborted(signal);
    const transaction = database.transaction(
      [
        databaseStores.dsh_session_headers,
        databaseStores.dsh_session_events,
      ],
      "readonly",
    );
    const completion = transactionDone(transaction);
    const [header, eventRecords] = await Promise.all([
      requestResult(
        transaction.objectStore(databaseStores.dsh_session_headers)
          .get(sessionId),
      ) as Promise<SessionHeaderRecord | undefined>,
      requestResult(
        transaction.objectStore(databaseStores.dsh_session_events)
          .getAll(sessionEventRange(sessionId, fromSeq)),
      ) as Promise<SessionEventRecord[]>,
    ]);
    await completion;
    throwIfAborted(signal);
    if (header === undefined) {
      if (eventRecords.length > 0) {
        throw storageError(sessionId, "has events without a header");
      }
      return undefined;
    }
    validateHeaderRecord(header, sessionId);
    const expectedCount = Math.max(0, header.event_count - fromSeq);
    return {
      meta: header.header,
      events: validateEventRecords(
        eventRecords,
        sessionId,
        Math.min(fromSeq, header.event_count),
        expectedCount,
      ),
    };
  }

  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    if (events.length === 0) return;
    const sessionId = String(meta.id);
    const database = await this.database.open();
    const transaction = database.transaction(
      [
        databaseStores.dsh_session_headers,
        databaseStores.dsh_session_events,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);

    try {
      const headerStore = transaction.objectStore(
        databaseStores.dsh_session_headers,
      );
      const eventStore = transaction.objectStore(
        databaseStores.dsh_session_events,
      );
      const existing = await requestResult(
        headerStore.get(sessionId),
      ) as SessionHeaderRecord | undefined;
      if (isMaterialized !== (existing !== undefined)) {
        throw storageError(sessionId, "materialization state changed");
      }
      if (existing !== undefined) {
        validateHeaderRecord(existing, sessionId);
        if (!sameHeader(existing.header, meta)) {
          throw storageError(sessionId, "header changed");
        }
      }
      const expectedSeq = existing?.event_count ?? 0;
      assertBatch(events, expectedSeq);
      for (const event of events) {
        eventStore.add({
          session_id: sessionId,
          seq: event.seq,
          event,
        } satisfies SessionEventRecord);
      }
      headerStore.put({
        session_id: sessionId,
        header: meta,
        storage_id: existing?.storage_id ?? crypto.randomUUID(),
        revision: (existing?.revision ?? 0) + 1,
        event_count: expectedSeq + events.length,
      } satisfies SessionHeaderRecord);
      await completion;
    } catch (error) {
      abortTransaction(transaction);
      await completion.catch(() => undefined);
      throw error;
    }
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: unknown,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (tornMarker !== undefined) {
      throw storageError(
        String(meta.id),
        "cannot contain a torn transactional tail",
      );
    }
    if (closers.length === 0) return;
    await this.appendBatch(meta, closers, true);
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    throwIfAborted(signal);
    const database = await this.database.open();
    throwIfAborted(signal);
    const transaction = database.transaction(
      databaseStores.dsh_session_headers,
      "readonly",
    );
    const completion = transactionDone(transaction);
    const records = await requestResult(
      transaction.objectStore(databaseStores.dsh_session_headers).getAll(),
    ) as SessionHeaderRecord[];
    await completion;
    throwIfAborted(signal);
    for (const record of records) {
      validateHeaderRecord(record, record.session_id);
    }
    return records
      .sort((left, right) => left.session_id.localeCompare(right.session_id))
      .map((record) => record.header);
  }

  async deleteStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const sessionId = String(id);
    const database = await this.database.open();
    throwIfAborted(signal);
    const transaction = database.transaction(
      [
        databaseStores.dsh_session_headers,
        databaseStores.dsh_session_events,
      ],
      "readwrite",
    );
    const completion = transactionDone(transaction);
    transaction.objectStore(databaseStores.dsh_session_headers)
      .delete(sessionId);
    transaction.objectStore(databaseStores.dsh_session_events)
      .delete(sessionEventRange(sessionId, 0));
    await completion;
  }
}

function revisionOf(
  record: SessionHeaderRecord,
): ReturnType<typeof SessionPersistenceRevision> {
  return SessionPersistenceRevision(
    `${record.storage_id}:${record.revision}`,
  );
}

function validateHeaderRecord(
  record: SessionHeaderRecord,
  sessionId: string,
): void {
  if (
    record === null ||
    typeof record !== "object" ||
    record.session_id !== sessionId ||
    record.header === null ||
    typeof record.header !== "object" ||
    String(record.header.id) !== sessionId ||
    typeof record.storage_id !== "string" ||
    record.storage_id.length === 0 ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    !Number.isSafeInteger(record.event_count) ||
    record.event_count < 1
  ) {
    throw storageError(sessionId, "has invalid header metadata");
  }
}

function validateEventRecords(
  records: readonly SessionEventRecord[],
  sessionId: string,
  expectedSeq: number,
  expectedCount: number,
): SessionEvent[] {
  if (records.length !== expectedCount) {
    throw storageError(sessionId, "has an incomplete event region");
  }
  return records.map((record, index) => {
    const seq = expectedSeq + index;
    if (
      record === null ||
      typeof record !== "object" ||
      record.session_id !== sessionId ||
      record.seq !== seq ||
      record.event === null ||
      typeof record.event !== "object" ||
      record.event.seq !== seq
    ) {
      throw storageError(sessionId, `has an invalid event at seq ${seq}`);
    }
    return record.event;
  });
}

function assertBatch(
  events: readonly SessionEvent[],
  expectedSeq: number,
): void {
  for (const [index, event] of events.entries()) {
    const expected = expectedSeq + index;
    if (event.seq !== expected) {
      throw new DshrboxBrowserSessionStorageError(
        `DSH event seq ${event.seq} does not match stored seq ${expected}.`,
      );
    }
  }
}

function sameHeader(left: SessionHeader, right: SessionHeader): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sessionEventRange(
  sessionId: string,
  fromSeq: number,
): IDBKeyRange {
  return IDBKeyRange.bound(
    [sessionId, fromSeq],
    [sessionId, Number.MAX_SAFE_INTEGER],
  );
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // A completed/aborted transaction already has the desired outcome.
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ??
    new DOMException("The DSH session operation was aborted.", "AbortError");
}

function storageError(
  sessionId: string,
  detail: string,
): DshrboxBrowserSessionStorageError {
  return new DshrboxBrowserSessionStorageError(
    `Stored DSH session ${sessionId} ${detail}.`,
  );
}
