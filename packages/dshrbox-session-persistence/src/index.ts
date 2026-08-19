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
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from "@deepseek-ai/dsh-session-persistence";

export const DSHRBOX_RUNTIME_ID = "dsh";

export type DshrboxSessionPersistenceConfig = {
  backend: PersistenceBackend;
  prepared_session_cache_size?: number;
  write_batch_max_delay_ms?: number;
};

/**
 * DSH persistence service over a host-supplied canonical session backend.
 *
 * The backend stores SessionHeader and SessionEvent values directly. Project
 * documents and viewer projections are deliberately outside this boundary.
 */
export class DshrboxSessionPersistence extends SessionPersistence {
  static inject = ["sessions"];

  readonly supportsRawArtifacts = false;

  private readonly backend: PersistenceBackend;
  private readonly coordinator: PersistenceCoordinator;

  constructor(ctx: Context, config: DshrboxSessionPersistenceConfig) {
    assertConfig(config);
    super(ctx);
    this.backend = config.backend;
    this.coordinator = new PersistenceCoordinator(ctx, this.backend, {
      preparedSessionCacheSize:
        config.prepared_session_cache_size ??
        DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs:
        config.write_batch_max_delay_ms ??
        DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    });
  }

  locate(meta: SessionHeader): SessionLocation | undefined {
    return this.backend.locate?.(meta);
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

function assertConfig(config: DshrboxSessionPersistenceConfig): void {
  if (
    config === null ||
    typeof config !== "object" ||
    config.backend === null ||
    typeof config.backend !== "object" ||
    typeof config.backend.loadStored !== "function" ||
    typeof config.backend.readStoredRevision !== "function" ||
    typeof config.backend.appendBatch !== "function" ||
    typeof config.backend.commitRepair !== "function" ||
    typeof config.backend.list !== "function"
  ) {
    throw new TypeError(
      "dshrbox session persistence requires a DSH persistence backend",
    );
  }
}

export type { PersistenceBackend } from "@deepseek-ai/dsh-session-persistence";
export type { DshrboxSessionBackend } from "./backend.ts";
export { MemoryDshrboxSessionBackend } from "./memory.ts";
