import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCatalogService } from "@researchbox/agent-core";
import { createCommand } from "@researchbox/protocol";
import {
  RESEARCHBOX_LEGACY_WRITER_LOCK,
  RESEARCHBOX_MAINTENANCE_LOCK,
  projectCommandLock,
} from "@researchbox/app-runtime-browser/command-coordinator";
import { startBrowserRuntime } from "@researchbox/app-runtime-browser/runtime";

test("creates a core immediately and locks bootstrap only for its command", async () => {
  const host = createHost();
  const lockManager = createImmediateLockManager();
  const coreCommands = [];
  let createCoreCalls = 0;
  let coreDisposeCalls = 0;
  let servicesCloseCalls = 0;

  const runtime = startBrowserRuntime({
    host,
    lockManager,
    createServices() {
      const providerCatalog = new ProviderCatalogService({
        model: defaultModel,
      });
      return {
        providerCatalog,
        modelTransport: createModelTransport(),
        close() {
          servicesCloseCalls += 1;
          providerCatalog.close();
        },
      };
    },
    createCore() {
      createCoreCalls += 1;
      return {
        async handle(command) {
          coreCommands.push(command);
        },
        reportHostError() {},
        dispose() {
          coreDisposeCalls += 1;
        },
      };
    },
  });

  assert.equal(createCoreCalls, 1);
  assert.equal(
    host.events.some(
      (event) =>
        event.type === "core_lifecycle" &&
        event.payload.phase === "initializing_workspace",
    ),
    true,
  );
  assert.equal(
    host.events.some(
      (event) =>
        event.type === "core_lifecycle" &&
        (event.payload.phase === "electing" ||
          event.payload.phase === "waiting_for_writer"),
    ),
    false,
  );

  const bootstrap = createCommand("bootstrap", {});
  host.onmessage({ data: bootstrap });
  await flushTasks();

  assert.deepEqual(coreCommands, [bootstrap]);
  assert.deepEqual(lockManager.requests, [
    { name: RESEARCHBOX_LEGACY_WRITER_LOCK, mode: "shared" },
    { name: RESEARCHBOX_MAINTENANCE_LOCK, mode: "exclusive" },
  ]);
  assert.equal(lockManager.activeCount, 0);

  await runtime.dispose();
  assert.equal(coreDisposeCalls, 1);
  assert.equal(servicesCloseCalls, 1);
});

test("provider discovery and refresh stay live while bootstrap waits", async () => {
  const host = createHost();
  const lockManager = createBlockedMaintenanceLockManager();
  const coreCommands = [];
  let createCoreCalls = 0;
  let discoveryCalls = 0;
  const gateway = {
    async listModels() {
      discoveryCalls += 1;
      return [descriptor(`model-${discoveryCalls}`)];
    },
    async *stream() {
      yield { type: "done" };
    },
  };

  const runtime = startBrowserRuntime({
    host,
    lockManager,
    createServices() {
      const providerCatalog = new ProviderCatalogService({
        model: defaultModel,
        providers: providerDefinitions,
        modelCatalog: gateway,
      });
      return {
        providerCatalog,
        modelTransport: gateway,
        close() {
          providerCatalog.close();
        },
      };
    },
    createCore() {
      createCoreCalls += 1;
      return {
        async handle(command) {
          coreCommands.push(command);
        },
        reportHostError() {},
      };
    },
  });

  const bootstrap = createCommand("bootstrap", {});
  host.onmessage({ data: bootstrap });
  await flushTasks();
  assert.equal(createCoreCalls, 1);
  assert.deepEqual(coreCommands, []);

  const navigation = createCommand("fs_list", {
    project_id: "project-1",
    path: "/",
  });
  const abort = createCommand("abort", {
    project_id: "project-1",
    session_id: "session-1",
  });
  host.onmessage({ data: navigation });
  host.onmessage({ data: abort });
  await flushTasks();
  assert.deepEqual(coreCommands, []);

  const refresh = createCommand("provider_refresh", {
    provider_id: "local-openai",
  });
  host.onmessage({ data: refresh });
  await flushTasks();
  await flushTasks();

  assert.equal(discoveryCalls >= 1, true);
  assert.equal(
    host.events.some(
      (event) =>
        event.type === "provider_catalog_snapshot" &&
        event.request_id === refresh.request_id,
    ),
    true,
  );
  assert.deepEqual(lockManager.requests, [
    { name: RESEARCHBOX_LEGACY_WRITER_LOCK, mode: "shared" },
    { name: RESEARCHBOX_MAINTENANCE_LOCK, mode: "exclusive" },
  ]);

  lockManager.grant();
  await flushTasks();
  await flushTasks();
  assert.deepEqual(coreCommands, [bootstrap, navigation, abort]);

  await runtime.dispose();
});

test("canceling an export aborts its pending project lock wait", async () => {
  const host = createHost();
  const projectId = "project-1";
  const lockManager = createBlockedProjectLockManager(projectId);
  const coreCommands = [];
  const runtime = startBrowserRuntime({
    host,
    lockManager,
    createServices() {
      const providerCatalog = new ProviderCatalogService({
        model: defaultModel,
      });
      return {
        providerCatalog,
        modelTransport: createModelTransport(),
        close() {
          providerCatalog.close();
        },
      };
    },
    createCore() {
      return {
        async handle(command) {
          coreCommands.push(command);
        },
        reportHostError() {},
      };
    },
  });

  const bootstrap = createCommand("bootstrap", {});
  host.onmessage({ data: bootstrap });
  await flushTasks();
  await flushTasks();

  const exportCommand = createCommand("workspace_export", {
    project_id: projectId,
  });
  host.onmessage({ data: exportCommand });
  await flushTasks();
  assert.equal(
    lockManager.requests.some(
      (request) =>
        request.name === projectCommandLock(projectId) &&
        request.mode === "exclusive",
    ),
    true,
  );
  assert.equal(
    coreCommands.some((command) => command.type === "workspace_export"),
    false,
  );

  const cancelCommand = createCommand("workspace_export_cancel", {
    target_request_id: exportCommand.request_id,
  });
  host.onmessage({ data: cancelCommand });
  await flushTasks();
  lockManager.grant();
  await flushTasks();

  assert.deepEqual(coreCommands, [bootstrap, cancelCommand]);
  assert.equal(
    host.events.some(
      (event) =>
        event.type === "error" &&
        event.request_id === exportCommand.request_id,
    ),
    false,
  );
  await runtime.dispose();
});

test("duplicate export request ids share one pending lock and core call", async () => {
  const host = createHost();
  const projectId = "project-1";
  const lockManager = createBlockedProjectLockManager(projectId);
  const coreCommands = [];
  const runtime = startBrowserRuntime({
    host,
    lockManager,
    createServices() {
      const providerCatalog = new ProviderCatalogService({
        model: defaultModel,
      });
      return {
        providerCatalog,
        modelTransport: createModelTransport(),
        close() {
          providerCatalog.close();
        },
      };
    },
    createCore() {
      return {
        async handle(command) {
          coreCommands.push(command);
        },
        reportHostError() {},
      };
    },
  });

  const bootstrap = createCommand("bootstrap", {});
  host.onmessage({ data: bootstrap });
  await flushTasks();
  await flushTasks();

  const exportCommand = createCommand("workspace_export", {
    project_id: projectId,
  });
  host.onmessage({ data: exportCommand });
  host.onmessage({
    data: {
      ...exportCommand,
      payload: { ...exportCommand.payload },
    },
  });
  await flushTasks();
  assert.equal(
    lockManager.requests.filter(
      (request) =>
        request.name === projectCommandLock(projectId) &&
        request.mode === "exclusive",
    ).length,
    1,
  );

  lockManager.grant();
  await flushTasks();
  await flushTasks();
  assert.equal(
    coreCommands.filter(
      (command) => command.type === "workspace_export",
    ).length,
    1,
  );
  await runtime.dispose();
});

test("failed bootstrap closes the core and reports a failed lifecycle", async () => {
  const host = createHost();
  const lockManager = createImmediateLockManager();
  let coreDisposeCalls = 0;
  const runtime = startBrowserRuntime({
    host,
    lockManager,
    createServices() {
      const providerCatalog = new ProviderCatalogService({
        model: defaultModel,
      });
      return {
        providerCatalog,
        modelTransport: createModelTransport(),
        close() {
          providerCatalog.close();
        },
      };
    },
    createCore() {
      return {
        async handle(command) {
          if (command.type === "bootstrap") {
            throw new Error("IndexedDB could not open");
          }
        },
        reportHostError() {},
        dispose() {
          coreDisposeCalls += 1;
        },
      };
    },
  });

  host.onmessage({ data: createCommand("bootstrap", {}) });
  await flushTasks();
  await flushTasks();

  const lifecycle = host.events.findLast(
    (event) => event.type === "core_lifecycle",
  );
  assert.equal(lifecycle?.payload.phase, "failed");
  assert.match(lifecycle?.payload.status_message, /IndexedDB could not open/);
  assert.equal(coreDisposeCalls, 1);

  await runtime.dispose();
  assert.equal(coreDisposeCalls, 1);
});

test("runtime disposal waits for core cleanup before closing services", async () => {
  const host = createHost();
  const coreDisposal = deferred();
  const order = [];
  const runtime = startBrowserRuntime({
    host,
    lockManager: createImmediateLockManager(),
    createServices() {
      const providerCatalog = new ProviderCatalogService({
        model: defaultModel,
      });
      return {
        providerCatalog,
        modelTransport: createModelTransport(),
        close() {
          order.push("services_close");
          providerCatalog.close();
        },
      };
    },
    createCore() {
      return {
        async handle() {},
        reportHostError() {},
        async dispose() {
          order.push("core_dispose_started");
          await coreDisposal.promise;
          order.push("core_dispose_finished");
        },
      };
    },
  });

  const disposing = runtime.dispose();
  await flushTasks();
  assert.deepEqual(order, ["core_dispose_started"]);

  coreDisposal.resolve();
  await disposing;
  assert.deepEqual(order, [
    "core_dispose_started",
    "core_dispose_finished",
    "services_close",
  ]);
  assert.equal(runtime.dispose(), disposing);
});

function createHost() {
  return {
    onmessage: null,
    events: [],
    postMessage(event) {
      this.events.push(event);
    },
  };
}

function createImmediateLockManager() {
  let activeCount = 0;
  return {
    requests: [],
    get activeCount() {
      return activeCount;
    },
    async request(name, options, operation) {
      this.requests.push({ name, mode: options.mode });
      options.signal?.throwIfAborted();
      activeCount += 1;
      try {
        return await operation({ name, mode: options.mode });
      } finally {
        activeCount -= 1;
      }
    },
  };
}

function createBlockedMaintenanceLockManager() {
  let grantRequest = null;
  let isMaintenanceBlocked = true;
  return {
    requests: [],
    request(name, options, operation) {
      this.requests.push({ name, mode: options.mode });
      if (
        name !== RESEARCHBOX_MAINTENANCE_LOCK ||
        !isMaintenanceBlocked
      ) {
        options.signal?.throwIfAborted();
        return Promise.resolve(
          operation({ name, mode: options.mode }),
        );
      }
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        options.signal?.addEventListener("abort", abort, { once: true });
        grantRequest = () => {
          options.signal?.removeEventListener("abort", abort);
          void Promise.resolve(
            operation({ name, mode: options.mode }),
          ).then(resolve, reject);
        };
      });
    },
    grant() {
      assert.ok(grantRequest, "No catalog request is waiting");
      const grant = grantRequest;
      grantRequest = null;
      isMaintenanceBlocked = false;
      grant();
    },
  };
}

function createBlockedProjectLockManager(projectId) {
  const blockedLock = projectCommandLock(projectId);
  let grantRequest = null;
  let isBlocked = true;
  return {
    requests: [],
    request(name, options, operation) {
      this.requests.push({ name, mode: options.mode });
      options.signal?.throwIfAborted();
      if (name !== blockedLock || !isBlocked) {
        return Promise.resolve(
          operation({ name, mode: options.mode }),
        );
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const abort = () => {
          if (settled) return;
          settled = true;
          reject(
            options.signal?.reason ??
              new DOMException("Aborted", "AbortError"),
          );
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        grantRequest = () => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", abort);
          void Promise.resolve(
            operation({ name, mode: options.mode }),
          ).then(resolve, reject);
        };
      });
    },
    grant() {
      isBlocked = false;
      grantRequest?.();
      grantRequest = null;
    },
  };
}

function createModelTransport() {
  return {
    async *stream() {
      yield { type: "done" };
    },
  };
}

function descriptor(modelId) {
  return {
    provider_id: "local-openai",
    provider_display_name: "Local OpenAI",
    model_id: modelId,
    display_name: modelId,
    context_window: 128_000,
    max_output_tokens: 8_192,
    supports_tools: true,
    supports_reasoning: false,
  };
}

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const defaultModel = {
  id: "researchbox-mock",
  name: "rrbox Mock",
  api: "openai-completions",
  provider: "researchbox",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const providerDefinitions = [
  {
    provider_id: "researchbox",
    display_name: "rrbox",
    kind: "mock",
    models: [defaultModel],
  },
  {
    provider_id: "local-openai",
    display_name: "Local OpenAI",
    kind: "openai_compatible",
    discover_models: true,
  },
];
