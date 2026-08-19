import type { SessionId } from "@deepseek-ai/dsh-session";
import type { PersistenceBackend } from "@deepseek-ai/dsh-session-persistence";

/** Host lifecycle extension over DSH's append-only persistence primitives. */
export interface DshrboxSessionBackend extends PersistenceBackend {
  deleteStored(id: SessionId, signal?: AbortSignal): Promise<void>;
}
