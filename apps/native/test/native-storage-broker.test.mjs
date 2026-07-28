import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeStorageRpcClient,
  NativeStorageRpcError,
} from "@researchbox/storage-native";
import {
  createNativeStoragePortBroker,
} from "../src/lib/native-storage-broker.ts";

test("relays typed storage requests over a dedicated MessagePort", async () => {
  const channel = new MessageChannel();
  const requests = [];
  const broker = createNativeStoragePortBroker(
    channel.port1,
    async (request) => {
      requests.push(request);
      return {
        protocol_version: 1,
        request_id: request.request_id,
        result: {
          kind: "health",
          initialized: true,
        },
      };
    },
  );
  const client = new NativeStorageRpcClient(channel.port2, {
    create_request_id: () => "health-request",
  });

  assert.equal(await client.health(), true);
  assert.deepEqual(requests, [
    {
      protocol_version: 1,
      request_id: "health-request",
      operation: { kind: "health" },
    },
  ]);

  client.close();
  broker.close();
});

test("turns rejected native invocations into correlated errors", async () => {
  const channel = new MessageChannel();
  const broker = createNativeStoragePortBroker(
    channel.port1,
    async () => {
      throw new Error("Tauri command unavailable.");
    },
  );
  const client = new NativeStorageRpcClient(channel.port2, {
    create_request_id: () => "failed-request",
  });

  await assert.rejects(
    client.health(),
    (error) =>
      error instanceof NativeStorageRpcError &&
      error.code === "internal" &&
      error.message === "Tauri command unavailable.",
  );

  client.close();
  broker.close();
});

test("rejects malformed nested requests before invoking Tauri", async () => {
  const channel = new MessageChannel();
  const invoked = [];
  const broker = createNativeStoragePortBroker(
    channel.port1,
    async (request) => {
      invoked.push(request);
      return {
        protocol_version: 1,
        request_id: request.request_id,
        result: { kind: "initialized" },
      };
    },
  );
  const invalidOperations = [
    {
      kind: "workspace_read",
      workspace: { project_id: "project-1" },
      path: "/README.md",
    },
    {
      kind: "workspace_write",
      workspace: createHandle(),
      path: "/note.md",
      content: "hello",
      options: { expected_content: 42 },
    },
    {
      kind: "workspace_remove",
      workspace: createHandle(),
      path: "/note.md",
      options: {
        change: {
          change_id: "change-1",
          session_id: "session-1",
        },
      },
    },
    {
      kind: "workspace_create",
      project_id: "project-1",
      initial_files: { path: "/note.md", content: "not-an-array" },
    },
    {
      kind: "project_store_save",
      state: {},
      expected_revision: null,
    },
    {
      kind: "project_store_save",
      state: {
        schema_version: 2,
        state_revision: 1,
        active_project_id: "project-1",
        active_session_id: null,
        projects: [
          {
            project_id: "project-1",
            name: "Legacy project",
            created_at: "2026-07-28T00:00:00.000Z",
            updated_at: "2026-07-28T00:00:00.000Z",
            last_session_id: null,
            new_chat_draft: "",
          },
        ],
        sessions: [],
        documents: [],
      },
      expected_revision: null,
    },
    {
      kind: "health",
      unexpected: true,
    },
  ];

  for (const [index, operation] of invalidOperations.entries()) {
    const requestId = `invalid-${index}`;
    const response = nextPortMessage(channel.port2);
    channel.port2.postMessage({
      protocol_version: 1,
      request_id: requestId,
      operation,
    });
    const received = await response;
    assert.equal(received.request_id, requestId);
    assert.equal(received.result.kind, "error");
    assert.equal(received.result.error.code, "invalid_request");
  }

  assert.deepEqual(invoked, []);
  broker.close();
  channel.port2.close();
});

test("defers initial-file domain validation to atomic native create", async () => {
  const channel = new MessageChannel();
  const invoked = [];
  const broker = createNativeStoragePortBroker(
    channel.port1,
    async (request) => {
      invoked.push(request);
      return {
        protocol_version: 1,
        request_id: request.request_id,
        result: {
          kind: "error",
          error: {
            code: "workspace_already_exists",
            message: "The native create observed the existing workspace first.",
          },
        },
      };
    },
  );
  const response = nextPortMessage(channel.port2);
  channel.port2.postMessage({
    protocol_version: 1,
    request_id: "domain-validation",
    operation: {
      kind: "workspace_create",
      project_id: "project-1",
      initial_files: [{ path: "/note.md", content: 42 }],
    },
  });

  const received = await response;
  assert.equal(received.result.error.code, "workspace_already_exists");
  assert.deepEqual(invoked[0].operation.initial_files, [
    { path: "/note.md", content: 42 },
  ]);

  broker.close();
  channel.port2.close();
});

test("preserves explicit-null write CAS through broker validation", async () => {
  const channel = new MessageChannel();
  const invoked = [];
  const broker = createNativeStoragePortBroker(
    channel.port1,
    async (request) => {
      invoked.push(request);
      return {
        protocol_version: 1,
        request_id: request.request_id,
        result: {
          kind: "workspace_written",
          value: {
            workspace_revision: 1,
            result: {
              path: "/note.md",
              change_kind: "created",
              before_content: null,
              after_content: "hello",
              change: null,
            },
          },
        },
      };
    },
  );
  const response = nextPortMessage(channel.port2);
  channel.port2.postMessage({
    protocol_version: 1,
    request_id: "explicit-null",
    operation: {
      kind: "workspace_write",
      workspace: createHandle(),
      path: "/note.md",
      content: "hello",
      options: { expected_content: null },
    },
  });

  assert.equal((await response).result.kind, "workspace_written");
  assert.equal(
    invoked[0].operation.options.expected_content,
    null,
  );

  broker.close();
  channel.port2.close();
});

function createHandle() {
  return {
    project_id: "project-1",
    incarnation_id: "incarnation-1",
  };
}

function nextPortMessage(port) {
  port.start();
  return new Promise((resolve) => {
    port.addEventListener(
      "message",
      (event) => resolve(event.data),
      { once: true },
    );
  });
}
