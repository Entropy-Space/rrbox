import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import {
  DshrboxSessionPersistence,
} from "@dshrbox/session-persistence";
import {
  NativeDshrboxSessionBackend,
} from "@dshrbox/session-persistence-native";
import {
  NATIVE_STORAGE_PROTOCOL_VERSION,
  NativeStorageRpcClient,
} from "@researchbox/storage-native";

test("persists DSH sessions through one project-scoped native boundary", async () => {
  const endpoint = new FakeNativeStorageEndpoint();
  const client = new NativeStorageRpcClient(endpoint, {
    create_request_id: createRequestIds(),
  });
  const backend = new NativeDshrboxSessionBackend(client, "project-a");
  const context = await createContext(backend);
  const id = SessionId("session-native-dsh");

  try {
    const session = context.sessions.create(id);
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await context.sessions.flush(session);

    const stored = await backend.loadStored(id);
    assert.equal(String(stored.meta.id), String(id));
    assert.deepEqual(
      stored.events.map((event) => event.type),
      ["turn/start", "turn/end"],
    );
    assert.deepEqual(
      (await backend.loadStoredFrom(id, 1)).events.map(
        (event) => event.type,
      ),
      ["turn/end"],
    );
    assert.equal((await backend.list()).length, 1);
    assert.equal(
      (await backend.readStoredRevision(id)).startsWith(
        `${"a".repeat(32)}:`,
      ),
      true,
    );

    const otherProject = new NativeDshrboxSessionBackend(
      client,
      "project-b",
    );
    assert.deepEqual(await otherProject.list(), []);
    assert.equal(await otherProject.loadStored(id), undefined);
    assert.equal(
      endpoint.requests
        .filter((request) => request.operation.kind.startsWith("dsh_session_"))
        .every((request) => request.operation.project_id.length > 0),
      true,
    );

    await backend.deleteStored(id);
    await backend.deleteStored(id);
    assert.equal(await backend.loadStored(id), undefined);
  } finally {
    await context.fiber.dispose();
    client.close();
  }
});

test("honors cancellation before native session I/O", async () => {
  const endpoint = new FakeNativeStorageEndpoint();
  const client = new NativeStorageRpcClient(endpoint, {
    create_request_id: createRequestIds(),
  });
  const backend = new NativeDshrboxSessionBackend(client, "project-a");
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    backend.loadStored(SessionId("session-aborted"), controller.signal),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(endpoint.requests, []);
  client.close();
});

async function createContext(backend) {
  const context = new Context();
  await context.plugin(SessionStore);
  await context.plugin(DshrboxSessionPersistence, {
    backend,
    write_batch_max_delay_ms: 1,
  });
  return context;
}

class FakeNativeStorageEndpoint {
  requests = [];
  #listeners = {
    message: new Set(),
    messageerror: new Set(),
  };
  #projects = new Map();
  #initialized = false;

  postMessage(request) {
    this.requests.push(structuredClone(request));
    let result;
    try {
      result = this.#handle(request.operation);
    } catch (error) {
      result = {
        kind: "error",
        error: {
          code: "internal",
          message: error instanceof Error ? error.message : "failure",
        },
      };
    }
    this.#emit({
      protocol_version: NATIVE_STORAGE_PROTOCOL_VERSION,
      request_id: request.request_id,
      result,
    });
  }

  addEventListener(type, listener) {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners[type].delete(listener);
  }

  start() {}
  close() {}

  #handle(operation) {
    if (operation.kind === "initialize") {
      this.#initialized = true;
      return { kind: "initialized" };
    }
    assert.equal(this.#initialized, true);
    const sessions = this.#project(operation.project_id);
    switch (operation.kind) {
      case "dsh_session_load": {
        const stored = sessions.get(operation.session_id);
        return {
          kind: "dsh_session_loaded",
          value: stored === undefined ? null : structuredClone(stored),
        };
      }
      case "dsh_session_load_from": {
        const stored = sessions.get(operation.session_id);
        return {
          kind: "dsh_session_suffix_loaded",
          value: stored === undefined
            ? null
            : {
                header: structuredClone(stored.header),
                events: structuredClone(
                  stored.events.filter(
                    (event) => event.seq >= operation.from_seq,
                  ),
                ),
              },
        };
      }
      case "dsh_session_read_revision": {
        const stored = sessions.get(operation.session_id);
        return {
          kind: "dsh_session_revision",
          value: stored === undefined
            ? null
            : {
                storage_id: stored.storage_id,
                revision: stored.revision,
              },
        };
      }
      case "dsh_session_append": {
        const sessionId = operation.header.id;
        const stored = sessions.get(sessionId);
        assert.equal(operation.is_materialized, stored !== undefined);
        const expectedSeq = stored?.events.length ?? 0;
        for (const [index, event] of operation.events.entries()) {
          assert.equal(event.seq, expectedSeq + index);
        }
        sessions.set(sessionId, {
          header: structuredClone(stored?.header ?? operation.header),
          events: [
            ...(stored?.events ?? []),
            ...structuredClone(operation.events),
          ],
          storage_id: stored?.storage_id ?? "a".repeat(32),
          revision: (stored?.revision ?? 0) + 1,
        });
        return { kind: "dsh_session_appended" };
      }
      case "dsh_session_list":
        return {
          kind: "dsh_sessions_listed",
          headers: [...sessions.values()].map((stored) =>
            structuredClone(stored.header)
          ),
        };
      case "dsh_session_delete":
        sessions.delete(operation.session_id);
        return { kind: "dsh_session_deleted" };
      default:
        throw new Error(`Unexpected operation ${operation.kind}.`);
    }
  }

  #project(projectId) {
    let sessions = this.#projects.get(projectId);
    if (sessions === undefined) {
      sessions = new Map();
      this.#projects.set(projectId, sessions);
    }
    return sessions;
  }

  #emit(data) {
    for (const listener of this.#listeners.message) {
      listener({ data: structuredClone(data) });
    }
  }
}

function createRequestIds() {
  let next = 0;
  return () => `native-dsh-${next++}`;
}
