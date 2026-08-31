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
  NativeStorageRpcClient,
  type NativeDshSessionRevision,
  type NativeDshStoredSession,
  type NativeDshStoredSessionSuffix,
} from "@researchbox/storage-native";

export class DshrboxNativeSessionStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshrboxNativeSessionStorageError";
  }
}

/** Project-scoped native SQLite implementation of DSH persistence. */
export class NativeDshrboxSessionBackend implements DshrboxSessionBackend {
  readonly name = "dshrbox native SQLite";

  private readonly client: NativeStorageRpcClient;
  private readonly projectId: string;

  constructor(client: NativeStorageRpcClient, projectId: string) {
    if (projectId.length === 0) {
      throw new TypeError("Native DSH persistence requires a project id.");
    }
    this.client = client;
    this.projectId = projectId;
  }

  async loadStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix | undefined> {
    await this.ready(signal);
    const sessionId = String(id);
    const result = await this.client.request({
      kind: "dsh_session_load",
      project_id: this.projectId,
      session_id: sessionId,
    }, { signal });
    if (result.value === null) return undefined;
    const stored = requireStoredSession(result.value, sessionId);
    return {
      meta: stored.header,
      events: stored.events,
      revision: revisionOf(stored),
    };
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    await this.ready(signal);
    const result = await this.client.request({
      kind: "dsh_session_read_revision",
      project_id: this.projectId,
      session_id: String(id),
    }, { signal });
    return result.value === null ? undefined : revisionOf(result.value);
  }

  async loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    await this.ready(signal);
    const sessionId = String(id);
    const result = await this.client.request({
      kind: "dsh_session_load_from",
      project_id: this.projectId,
      session_id: sessionId,
      from_seq: fromSeq,
    }, { signal });
    if (result.value === null) return undefined;
    return requireStoredSuffix(result.value, sessionId, fromSeq);
  }

  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    if (events.length === 0) return;
    await this.ready();
    await this.client.request({
      kind: "dsh_session_append",
      project_id: this.projectId,
      header: meta,
      events,
      is_materialized: isMaterialized,
    });
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
    await this.ready(signal);
    const result = await this.client.request({
      kind: "dsh_session_list",
      project_id: this.projectId,
    }, { signal });
    return result.headers
      .map((header) => requireHeader(header))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  async deleteStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.ready(signal);
    await this.client.request({
      kind: "dsh_session_delete",
      project_id: this.projectId,
      session_id: String(id),
    }, { signal });
  }

  private async ready(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.client.ensureInitialized();
    throwIfAborted(signal);
  }
}

function requireStoredSession(
  value: NativeDshStoredSession,
  sessionId: string,
): { header: SessionHeader; events: SessionEvent[] } & NativeDshSessionRevision {
  const header = requireHeader(value.header, sessionId);
  const events = requireEvents(value.events, sessionId, 0);
  requireRevision(value, sessionId);
  return {
    header,
    events,
    storage_id: value.storage_id,
    revision: value.revision,
  };
}

function requireStoredSuffix(
  value: NativeDshStoredSessionSuffix,
  sessionId: string,
  fromSeq: number,
): StoredSuffix {
  const header = requireHeader(value.header, sessionId);
  const events = requireEvents(
    value.events,
    sessionId,
    value.events.length === 0 ? undefined : fromSeq,
  );
  return { meta: header, events };
}

function requireHeader(value: unknown, sessionId?: string): SessionHeader {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { id?: unknown }).id !== "string" ||
    (value as { id: string }).id.length === 0 ||
    !Number.isSafeInteger((value as { version?: unknown }).version) ||
    (value as { version: number }).version < 0 ||
    !Number.isSafeInteger((value as { createdAt?: unknown }).createdAt) ||
    (value as { createdAt: number }).createdAt < 0
  ) {
    throw storageError(sessionId ?? "unknown", "has invalid header metadata");
  }
  if (
    sessionId !== undefined &&
    (value as { id: string }).id !== sessionId
  ) {
    throw storageError(sessionId, "has a mismatched header id");
  }
  return value as SessionHeader;
}

function requireEvents(
  values: readonly unknown[],
  sessionId: string,
  expectedSeq: number | undefined,
): SessionEvent[] {
  return values.map((value, index) => {
    const seq = expectedSeq === undefined ? undefined : expectedSeq + index;
    if (
      value === null ||
      typeof value !== "object" ||
      !Number.isSafeInteger((value as { seq?: unknown }).seq) ||
      (value as { seq: number }).seq < 0 ||
      (seq !== undefined && (value as { seq: number }).seq !== seq)
    ) {
      throw storageError(
        sessionId,
        `has an invalid event${seq === undefined ? "" : ` at seq ${seq}`}`,
      );
    }
    return value as SessionEvent;
  });
}

function requireRevision(
  value: NativeDshSessionRevision,
  sessionId = "unknown",
): void {
  if (
    !/^[0-9a-f]{32}$/u.test(value.storage_id) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw storageError(sessionId, "has invalid revision metadata");
  }
}

function revisionOf(
  value: NativeDshSessionRevision,
): ReturnType<typeof SessionPersistenceRevision> {
  requireRevision(value);
  return SessionPersistenceRevision(`${value.storage_id}:${value.revision}`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ??
    new DOMException("The DSH session operation was aborted.", "AbortError");
}

function storageError(
  sessionId: string,
  detail: string,
): DshrboxNativeSessionStorageError {
  return new DshrboxNativeSessionStorageError(
    `Stored DSH session ${sessionId} ${detail}.`,
  );
}
