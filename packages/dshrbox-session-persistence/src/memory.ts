import type {
  SessionEvent,
  SessionHeader,
  SessionId,
} from "@deepseek-ai/dsh-session";
import {
  SessionPersistenceRevision,
  type StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence";
import type { DshrboxSessionBackend } from "./backend.ts";

type StoredSession = {
  header: SessionHeader;
  events: SessionEvent[];
  revision: number;
};

/** Canonical in-memory backend for tests and explicitly ephemeral hosts. */
export class MemoryDshrboxSessionBackend implements DshrboxSessionBackend {
  readonly name = "dshrbox memory";

  private readonly sourceId = crypto.randomUUID();
  private readonly sessions = new Map<string, StoredSession>();

  async loadStored(id: SessionId): Promise<StoredPrefix | undefined> {
    const stored = this.sessions.get(String(id));
    if (stored === undefined) return undefined;
    return {
      meta: structuredClone(stored.header),
      events: structuredClone(stored.events),
      revision: this.revision(stored.revision),
    };
  }

  async readStoredRevision(
    id: SessionId,
  ): Promise<ReturnType<typeof SessionPersistenceRevision> | undefined> {
    const stored = this.sessions.get(String(id));
    return stored === undefined
      ? undefined
      : this.revision(stored.revision);
  }

  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    if (events.length === 0) return;
    const id = String(meta.id);
    const stored = this.sessions.get(id);
    if (isMaterialized !== (stored !== undefined)) {
      throw new Error(`DSH session materialization changed for ${id}.`);
    }
    if (
      stored !== undefined &&
      JSON.stringify(stored.header) !== JSON.stringify(meta)
    ) {
      throw new Error(`DSH session header changed for ${id}.`);
    }
    const expectedSeq = stored?.events.length ?? 0;
    assertBatch(events, expectedSeq);
    this.sessions.set(id, {
      header: structuredClone(stored?.header ?? meta),
      events: [...(stored?.events ?? []), ...structuredClone(events)],
      revision: (stored?.revision ?? 0) + 1,
    });
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: unknown,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (tornMarker !== undefined) {
      throw new Error("The in-memory backend cannot have a torn tail.");
    }
    if (closers.length === 0) return;
    const stored = this.sessions.get(String(meta.id));
    if (stored === undefined) {
      throw new Error(`Cannot repair missing DSH session ${meta.id}.`);
    }
    assertBatch(closers, stored.events.length);
    stored.events.push(...structuredClone(closers));
    stored.revision += 1;
  }

  async list(): Promise<SessionHeader[]> {
    return [...this.sessions.values()].map((stored) =>
      structuredClone(stored.header)
    );
  }

  async deleteStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.sessions.delete(String(id));
  }

  private revision(
    revision: number,
  ): ReturnType<typeof SessionPersistenceRevision> {
    return SessionPersistenceRevision(`${this.sourceId}:${revision}`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ??
    new DOMException("The DSH session operation was aborted.", "AbortError");
}

function assertBatch(
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
