import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectStoreConflictError,
} from "@researchbox/project-store";
import {
  VfsError,
  WorkspaceBackendError,
} from "@researchbox/vfs";
import {
  NATIVE_STORAGE_PROTOCOL_VERSION,
  NativeProjectStore,
  NativeStorageProtocolError,
  NativeStorageRpcClient,
  NativeWorkspaceBackend,
} from "../src/index.ts";

test("correlates concurrent requests and validates result kinds", async () => {
  const endpoint = new FakeEndpoint();
  const client = createClient(endpoint);
  const health = client.request({ kind: "health" });
  const usage = client.request({
    kind: "project_usage",
    project_id: "project-1",
  });

  endpoint.respond(endpoint.requests[1], {
    kind: "project_usage",
    value: createUsage(64),
  });
  endpoint.respond(endpoint.requests[0], {
    kind: "health",
    initialized: true,
  });

  assert.deepEqual(await usage, {
    kind: "project_usage",
    value: createUsage(64),
  });
  assert.deepEqual(await health, {
    kind: "health",
    initialized: true,
  });

  const mismatched = client.request({ kind: "health" });
  endpoint.respond(endpoint.requests[2], { kind: "initialized" });
  await assert.rejects(
    mismatched,
    /returned initialized for health; expected health/,
  );
  client.close();
});

test("fails closed when the endpoint violates the protocol", async () => {
  const endpoint = new FakeEndpoint();
  const client = createClient(endpoint);
  const first = client.request({ kind: "health" });
  const second = client.request({ kind: "initialize" });

  endpoint.emit({
    protocol_version: 99,
    request_id: endpoint.requests[0].request_id,
    result: { kind: "health", initialized: true },
  });

  await assert.rejects(first, NativeStorageProtocolError);
  await assert.rejects(second, NativeStorageProtocolError);
  await assert.rejects(
    client.request({ kind: "health" }),
    /connection is closed/,
  );
  assert.equal(endpoint.closed, true);
});

test("rejects additive fields outside the versioned response contract", async () => {
  const endpoint = new FakeEndpoint();
  const client = createClient(endpoint);
  const pending = client.request({ kind: "health" });

  endpoint.emit({
    protocol_version: NATIVE_STORAGE_PROTOCOL_VERSION,
    request_id: endpoint.requests[0].request_id,
    result: {
      kind: "health",
      initialized: true,
      unexpected: true,
    },
  });

  await assert.rejects(pending, NativeStorageProtocolError);
  assert.equal(endpoint.closed, true);
});

test("maps native errors to project, workspace, and VFS errors", async () => {
  const cases = [
    {
      operation: {
        kind: "project_store_save",
        state: createState(1),
        expected_revision: null,
      },
      code: "project_store_conflict",
      error: ProjectStoreConflictError,
    },
    {
      operation: {
        kind: "workspace_open",
        project_id: "missing",
      },
      code: "workspace_not_found",
      error: WorkspaceBackendError,
    },
    {
      operation: {
        kind: "workspace_read",
        workspace: createHandle(),
        path: "/missing.md",
      },
      code: "vfs_not_found",
      error: VfsError,
    },
  ];

  for (const [index, current] of cases.entries()) {
    const endpoint = new FakeEndpoint();
    const client = createClient(endpoint, `case-${index}`);
    const request = client.request(current.operation);
    endpoint.respond(endpoint.requests[0], {
      kind: "error",
      error: {
        code: current.code,
        message: `failure-${index}`,
      },
    });
    await assert.rejects(request, current.error);
    client.close();
  }
});

test("coalesces initialization and reports project usage", async () => {
  const endpoint = new FakeEndpoint((request) => {
    switch (request.operation.kind) {
      case "initialize":
        return { kind: "initialized" };
      case "project_usage":
        return {
          kind: "project_usage",
          value: createUsage(128),
        };
      default:
        throw new Error(`Unexpected ${request.operation.kind}`);
    }
  });
  const client = createClient(endpoint);

  await Promise.all([
    client.ensureInitialized(),
    client.ensureInitialized(),
    client.ensureInitialized(),
  ]);
  assert.equal(
    endpoint.requests.filter(
      (request) => request.operation.kind === "initialize",
    ).length,
    1,
  );
  assert.deepEqual(await client.getProjectUsage("project-1"), {
    logical_bytes: 128,
    database_bytes: 256,
    disk_bytes: 384,
    breakdown: {
      workspace_bytes: 64,
      conversation_bytes: 32,
      history_bytes: 16,
      database_overhead_bytes: 16,
    },
  });
  client.close();
});

test("rebases project mutations after a native revision conflict", async () => {
  let state = createState(1);
  let rejectFirstSave = true;
  const endpoint = new FakeEndpoint((request) => {
    switch (request.operation.kind) {
      case "initialize":
        return { kind: "initialized" };
      case "project_store_load":
        return {
          kind: "project_store_loaded",
          state: structuredClone(state),
        };
      case "project_store_save":
        if (rejectFirstSave) {
          rejectFirstSave = false;
          state = createState(2);
          state.projects[0].name = "External name";
          return {
            kind: "error",
            error: {
              code: "project_store_conflict",
              message: "Changed elsewhere.",
            },
          };
        }
        assert.equal(
          request.operation.expected_revision,
          state.state_revision,
        );
        state = structuredClone(request.operation.state);
        return { kind: "project_store_saved" };
      default:
        throw new Error(`Unexpected ${request.operation.kind}`);
    }
  });
  const client = createClient(endpoint);
  const store = new NativeProjectStore(client, {
    source_id: "native-store-test",
  });
  let mutationCalls = 0;
  const changes = [];
  store.subscribe((change) => changes.push(change));

  const commit = await store.mutate((draft) => {
    mutationCalls += 1;
    draft.projects[0].name = "Local name";
    return draft;
  });

  assert.equal(mutationCalls, 2);
  assert.equal(commit.state.state_revision, 3);
  assert.equal(commit.state.projects[0].name, "Local name");
  assert.deepEqual(changes, [
    {
      source_id: "native-store-test",
      state_revision: 3,
    },
  ]);
  store.close();
  client.close();
});

test("CAS-persists migrated project state after a revision conflict", async () => {
  let state = createLegacyState(4);
  let rejectFirstSave = true;
  const saveAttempts = [];
  const endpoint = new FakeEndpoint((request) => {
    switch (request.operation.kind) {
      case "initialize":
        return { kind: "initialized" };
      case "project_store_load":
        return {
          kind: "project_store_loaded",
          state: structuredClone(state),
        };
      case "project_store_save":
        saveAttempts.push({
          expected_revision: request.operation.expected_revision,
          state_revision: request.operation.state.state_revision,
        });
        if (rejectFirstSave) {
          rejectFirstSave = false;
          state = createLegacyState(5);
          return {
            kind: "error",
            error: {
              code: "project_store_conflict",
              message: "Migration raced another writer.",
            },
          };
        }
        state = structuredClone(request.operation.state);
        return { kind: "project_store_saved" };
      default:
        throw new Error(`Unexpected ${request.operation.kind}`);
    }
  });
  const client = createClient(endpoint);
  const store = new NativeProjectStore(client, {
    source_id: "migration-test",
  });
  const changes = [];
  store.subscribe((change) => changes.push(change));

  const loaded = await store.load();

  assert.equal(loaded.schema_version, 3);
  assert.equal(loaded.state_revision, 6);
  assert.deepEqual(loaded.projects[0].new_chat_model, {
    provider_id: "researchbox",
    model_id: "researchbox-mock",
  });
  assert.deepEqual(saveAttempts, [
    { expected_revision: 4, state_revision: 5 },
    { expected_revision: 5, state_revision: 6 },
  ]);
  assert.deepEqual(changes, [
    {
      source_id: "migration-test",
      state_revision: 6,
    },
  ]);

  store.close();
  client.close();
});

test("does not save or publish a no-op project mutation", async () => {
  const endpoint = new FakeEndpoint((request) => {
    switch (request.operation.kind) {
      case "initialize":
        return { kind: "initialized" };
      case "project_store_load":
        return {
          kind: "project_store_loaded",
          state: createState(7),
        };
      default:
        throw new Error(`Unexpected ${request.operation.kind}`);
    }
  });
  const client = createClient(endpoint);
  const store = new NativeProjectStore(client);
  const changes = [];
  store.subscribe((change) => changes.push(change));

  const commit = await store.mutate(() => null);

  assert.equal(commit.changed, false);
  assert.equal(commit.state.state_revision, 7);
  assert.deepEqual(changes, []);
  assert.equal(
    endpoint.requests.some(
      (request) => request.operation.kind === "project_store_save",
    ),
    false,
  );
  store.close();
  client.close();
});

test("bounds project mutation rebases under sustained contention", async () => {
  let mutationCalls = 0;
  const endpoint = new FakeEndpoint((request) => {
    switch (request.operation.kind) {
      case "initialize":
        return { kind: "initialized" };
      case "project_store_load":
        return {
          kind: "project_store_loaded",
          state: createState(mutationCalls + 1),
        };
      case "project_store_save":
        return {
          kind: "error",
          error: {
            code: "project_store_conflict",
            message: "Still busy.",
          },
        };
      default:
        throw new Error(`Unexpected ${request.operation.kind}`);
    }
  });
  const client = createClient(endpoint);
  const store = new NativeProjectStore(client);

  await assert.rejects(
    store.mutate((draft) => {
      mutationCalls += 1;
      draft.projects[0].name = `Attempt ${mutationCalls}`;
      return draft;
    }),
    /stayed busy after repeated retries/,
  );
  assert.equal(mutationCalls, 16);

  store.close();
  client.close();
});

test("preserves default seeds and missing versus null write CAS", async () => {
  const operations = [];
  const endpoint = new FakeEndpoint((request) => {
    operations.push(structuredClone(request.operation));
    switch (request.operation.kind) {
      case "initialize":
        return { kind: "initialized" };
      case "workspace_create":
        return {
          kind: "workspace_opened",
          workspace: createHandle(),
        };
      case "workspace_write":
        return {
          kind: "workspace_written",
          value: {
            workspace_revision: operations.length,
            result: {
              path: request.operation.path,
              change_kind: "created",
              before_content: null,
              after_content: request.operation.content,
              change: null,
            },
          },
        };
      default:
        throw new Error(`Unexpected ${request.operation.kind}`);
    }
  });
  const client = createClient(endpoint);
  const backend = new NativeWorkspaceBackend(client, {
    default_initial_files: {
      "/README.md": "# Native",
    },
  });
  const workspace = await backend.create("project-1");

  const explicitMissing = { expected_content: null };
  const guardedWrite = workspace.write("/new.md", "new", explicitMissing);
  explicitMissing.expected_content = "mutated too late";
  await guardedWrite;
  await workspace.write("/unchecked.md", "unchecked", {});

  assert.deepEqual(operations[1], {
    kind: "workspace_create",
    project_id: "project-1",
    initial_files: [
      {
        path: "/README.md",
        content: "# Native",
      },
    ],
  });
  assert.equal(
    Object.hasOwn(operations[2].options, "expected_content"),
    true,
  );
  assert.equal(operations[2].options.expected_content, null);
  assert.equal(
    Object.hasOwn(operations[3].options, "expected_content"),
    false,
  );
  client.close();
});

test("keeps malformed create seeds JSON-safe for atomic native validation", async () => {
  const operations = [];
  const endpoint = new FakeEndpoint((request) => {
    operations.push(structuredClone(request.operation));
    switch (request.operation.kind) {
      case "initialize":
        return { kind: "initialized" };
      case "workspace_create":
        return {
          kind: "workspace_opened",
          workspace: createHandle(),
        };
      default:
        throw new Error(`Unexpected ${request.operation.kind}`);
    }
  });
  const client = createClient(endpoint);
  const backend = new NativeWorkspaceBackend(client);
  const malformedContent = {};
  malformedContent.self = malformedContent;

  await backend.create("project-1", {
    initial_files: [
      {
        path: "/invalid.md",
        content: malformedContent,
      },
    ],
  });

  assert.deepEqual(operations[1], {
    kind: "workspace_create",
    project_id: "project-1",
    initial_files: [null],
  });

  await backend.create("project-1", {
    initial_files: {},
  });
  assert.deepEqual(operations[2], {
    kind: "workspace_create",
    project_id: "project-1",
    initial_files: [null],
  });
  client.close();
});

test("rejects a workspace handle for a different project", async () => {
  const endpoint = new FakeEndpoint((request) => {
    if (request.operation.kind === "initialize") {
      return { kind: "initialized" };
    }
    return {
      kind: "workspace_opened",
      workspace: {
        project_id: "other-project",
        incarnation_id: "incarnation-1",
      },
    };
  });
  const client = createClient(endpoint);
  const backend = new NativeWorkspaceBackend(client);

  await assert.rejects(
    backend.open("project-1"),
    /workspace for another project/,
  );
  client.close();
});

test("maps a deleted workspace handle to VFS not_found", async () => {
  const endpoint = new FakeEndpoint((request) => {
    switch (request.operation.kind) {
      case "initialize":
        return { kind: "initialized" };
      case "workspace_open":
        return {
          kind: "workspace_opened",
          workspace: createHandle(),
        };
      case "workspace_read":
        return {
          kind: "error",
          error: {
            code: "workspace_not_found",
            message: "The workspace was deleted.",
          },
        };
      default:
        throw new Error(`Unexpected ${request.operation.kind}`);
    }
  });
  const client = createClient(endpoint);
  const backend = new NativeWorkspaceBackend(client);
  const workspace = await backend.open("project-1");

  await assert.rejects(
    workspace.read("/README.md"),
    (error) =>
      error instanceof VfsError &&
      error.code === "not_found" &&
      error.message === "The workspace was deleted.",
  );

  client.close();
});

test("rejects corrupt or cross-mismatched native receipts", async () => {
  const cases = [
    {
      operation: {
        kind: "workspace_list_changes",
        workspace: createHandle(),
      },
      result: {
        kind: "workspace_changes_listed",
        value: {
          workspace_revision: 2,
          changes: [
            {
              ...createReceipt(),
              additions: 2,
            },
          ],
        },
      },
      message: /invalid line change counts/,
    },
    {
      operation: {
        kind: "workspace_get_change",
        workspace: createHandle(),
        change_id: "change-1",
      },
      result: {
        kind: "workspace_change",
        value: {
          workspace_revision: 2,
          change: {
            ...createReceipt(),
            applied_workspace_revision: 3,
          },
        },
      },
      message: /revision from the future/,
    },
    {
      operation: {
        kind: "workspace_write",
        workspace: createHandle(),
        path: "/other.md",
        content: "hello",
      },
      result: {
        kind: "workspace_written",
        value: {
          workspace_revision: 1,
          result: {
            path: "/other.md",
            change_kind: "created",
            before_content: null,
            after_content: "hello",
            change: createReceipt(),
          },
        },
      },
      message: /does not match its mutation result/,
    },
  ];

  for (const [index, current] of cases.entries()) {
    const endpoint = new FakeEndpoint();
    const client = createClient(endpoint, `receipt-${index}`);
    const pending = client.request(current.operation);
    endpoint.respond(endpoint.requests[0], current.result);
    await assert.rejects(pending, current.message);
  }
});

test("rejects valid native results correlated to another target", async () => {
  const cases = [
    {
      operation: {
        kind: "workspace_open",
        project_id: "project-1",
      },
      result: {
        kind: "workspace_opened",
        workspace: {
          project_id: "project-2",
          incarnation_id: "incarnation-2",
        },
      },
      message: /workspace for another project/,
    },
    {
      operation: {
        kind: "workspace_get_path_state",
        workspace: createHandle(),
        path: "/requested.md",
      },
      result: {
        kind: "workspace_path_state",
        value: {
          workspace_revision: 1,
          path: "/other.md",
          kind: "missing",
          path_revision: null,
        },
      },
      message: /another workspace path/,
    },
    {
      operation: {
        kind: "workspace_write",
        workspace: createHandle(),
        path: "/requested.md",
        content: "hello",
      },
      result: {
        kind: "workspace_written",
        value: {
          workspace_revision: 1,
          result: {
            path: "/other.md",
            change_kind: "created",
            before_content: null,
            after_content: "hello",
            change: null,
          },
        },
      },
      message: /write for another workspace path/,
    },
    {
      operation: {
        kind: "workspace_get_change",
        workspace: createHandle(),
        change_id: "requested-change",
      },
      result: {
        kind: "workspace_change",
        value: {
          workspace_revision: 2,
          change: createReceipt(),
        },
      },
      message: /different workspace change/,
    },
    {
      operation: {
        kind: "workspace_revert_change",
        workspace: createHandle(),
        change_id: "requested-change",
      },
      result: {
        kind: "workspace_change_reverted",
        value: {
          workspace_revision: 2,
          revert_outcome: "applied",
          reverted_at_workspace_revision: 2,
          change: {
            ...createReceipt(),
            reverted_at_workspace_revision: 2,
          },
        },
      },
      message: /different workspace change/,
    },
  ];

  for (const [index, current] of cases.entries()) {
    const endpoint = new FakeEndpoint();
    const client = createClient(endpoint, `correlation-${index}`);
    const pending = client.request(current.operation);
    endpoint.respond(endpoint.requests[0], current.result);
    await assert.rejects(pending, current.message);
    client.close();
  }
});

class FakeEndpoint {
  requests = [];
  closed = false;
  #listeners = new Map([
    ["message", new Set()],
    ["messageerror", new Set()],
  ]);
  #handler;

  constructor(handler = null) {
    this.#handler = handler;
  }

  postMessage(request) {
    this.requests.push(structuredClone(request));
    if (!this.#handler) return;
    queueMicrotask(() => {
      let result;
      try {
        result = this.#handler(structuredClone(request));
      } catch (error) {
        result = {
          kind: "error",
          error: {
            code: "internal",
            message:
              error instanceof Error
                ? error.message
                : "Fake endpoint failed.",
          },
        };
      }
      this.respond(request, result);
    });
  }

  addEventListener(type, listener) {
    this.#listeners.get(type)?.add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  start() {}

  close() {
    this.closed = true;
  }

  respond(request, result) {
    this.emit({
      protocol_version: NATIVE_STORAGE_PROTOCOL_VERSION,
      request_id: request.request_id,
      result,
    });
  }

  emit(data) {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data: structuredClone(data) });
    }
  }
}

function createClient(endpoint, prefix = "request") {
  let nextId = 0;
  return new NativeStorageRpcClient(endpoint, {
    create_request_id: () => `${prefix}-${++nextId}`,
  });
}

function createHandle() {
  return {
    project_id: "project-1",
    incarnation_id: "incarnation-1",
  };
}

function createUsage(logicalBytes) {
  return {
    logical_bytes: logicalBytes,
    database_bytes: logicalBytes * 2,
    disk_bytes: logicalBytes * 3,
    breakdown: {
      workspace_bytes: logicalBytes / 2,
      conversation_bytes: logicalBytes / 4,
      history_bytes: logicalBytes / 8,
      database_overhead_bytes: logicalBytes / 8,
    },
  };
}

function createReceipt() {
  return {
    change_id: "change-1",
    session_id: "session-1",
    tool_call_block_id: "block-1",
    assistant_message_index: 0,
    tool_call_id: "tool-call-1",
    tool_name: "write_file",
    created_at: "2026-07-28T00:00:00.000Z",
    applied_workspace_revision: 1,
    reverted_at_workspace_revision: null,
    path: "/note.md",
    change_kind: "created",
    before_content: null,
    after_content: "hello",
    additions: 1,
    deletions: 0,
    byte_size: 5,
  };
}

function createState(stateRevision) {
  return {
    schema_version: 3,
    state_revision: stateRevision,
    active_project_id: "project-1",
    active_session_id: null,
    projects: [
      {
        project_id: "project-1",
        name: "Native project",
        created_at: "2026-07-28T00:00:00.000Z",
        updated_at: "2026-07-28T00:00:00.000Z",
        last_session_id: null,
        new_chat_draft: "",
        new_chat_model: {
          provider_id: "researchbox",
          model_id: "researchbox-mock",
        },
      },
    ],
    sessions: [],
    documents: [],
  };
}

function createLegacyState(stateRevision) {
  const state = createState(stateRevision);
  state.schema_version = 2;
  delete state.projects[0].new_chat_model;
  return state;
}
