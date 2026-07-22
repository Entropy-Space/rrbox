import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCatalogService } from "@researchbox/agent-core";
import {
  PROTOCOL_VERSION,
  createCommand,
} from "@researchbox/protocol";
import { startBrowserRuntime } from "../browser/browser-runtime.ts";

test("provider discovery and refresh stay live while workspace ownership waits", async () => {
  const host = {
    onmessage: null,
    events: [],
    postMessage(event) {
      this.events.push(event);
    },
  };
  const lockManager = createContendedLockManager();
  const coreCommands = [];
  let createServicesCalls = 0;
  let createCoreCalls = 0;
  let discoveryCalls = 0;
  let streamCalls = 0;
  let releaseInitialDiscovery;
  const initialDiscovery = new Promise((resolve) => {
    releaseInitialDiscovery = resolve;
  });
  const gateway = {
    async listModels() {
      discoveryCalls += 1;
      return discoveryCalls === 1
        ? initialDiscovery
        : [descriptor("refreshed-model")];
    },
    async *stream() {
      streamCalls += 1;
      yield { type: "done" };
    },
  };

  const runtime = startBrowserRuntime({
    host,
    lockManager,
    createServices() {
      createServicesCalls += 1;
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
    createCore(_services, eventSink) {
      createCoreCalls += 1;
      return {
        async handle(command) {
          coreCommands.push(command);
          if (command.type === "bootstrap") {
            eventSink(coreEvent("core_lifecycle", { phase: "ready" }));
          }
        },
        reportHostError(code, message, requestId) {
          eventSink(
            coreEvent("error", { code, message }, requestId),
          );
        },
      };
    },
  });

  const bootstrap = createCommand("bootstrap", {});
  host.onmessage({ data: bootstrap });
  await flushTasks();

  assert.equal(createServicesCalls, 1);
  assert.equal(discoveryCalls, 1);
  assert.equal(createCoreCalls, 0);
  assert.equal(streamCalls, 0);
  assert.equal(
    host.events.some(
      (event) =>
        event.type === "core_lifecycle" &&
        event.payload.phase === "waiting_for_writer",
    ),
    true,
  );

  releaseInitialDiscovery([descriptor("initial-model")]);
  await flushTasks();
  assert.equal(
    latestCatalog(host.events).providers.some((provider) =>
      provider.models.some((model) => model.model_id === "initial-model"),
    ),
    true,
  );

  const refresh = createCommand("provider_refresh", {
    provider_id: "local-openai",
  });
  host.onmessage({ data: refresh });
  await flushTasks();
  assert.equal(discoveryCalls, 2);
  assert.equal(
    host.events.some(
      (event) =>
        event.type === "provider_catalog_snapshot" &&
        event.request_id === refresh.request_id,
    ),
    true,
  );

  lockManager.grant();
  await flushTasks();
  assert.equal(createCoreCalls, 1);
  assert.deepEqual(coreCommands, [bootstrap]);
  assert.equal(streamCalls, 0);

  runtime.dispose();
  await flushTasks();
});

test(
  "failed workspace bootstrap releases the writer lease",
  { timeout: 1_000 },
  async () => {
    const host = {
      onmessage: null,
      events: [],
      postMessage(event) {
        this.events.push(event);
      },
    };
    const lockManager = createAvailableLockManager();
    const runtime = startBrowserRuntime({
      host,
      lockManager,
      createServices() {
        const providerCatalog = new ProviderCatalogService({
          model: defaultModel,
        });
        return {
          providerCatalog,
          modelTransport: {
            async *stream() {
              yield { type: "done" };
            },
          },
          close() {
            providerCatalog.close();
          },
        };
      },
      createCore(_services, eventSink) {
        return {
          async handle(command) {
            if (command.type === "bootstrap") {
              throw new Error("IndexedDB could not open");
            }
          },
          reportHostError(code, message, requestId) {
            eventSink(coreEvent("error", { code, message }, requestId));
          },
        };
      },
    });

    host.onmessage({ data: createCommand("bootstrap", {}) });
    await lockManager.released;
    await flushTasks();

    const lifecycle = host.events.findLast(
      (event) => event.type === "core_lifecycle",
    );
    assert.equal(lifecycle?.payload.phase, "failed");
    assert.match(lifecycle?.payload.status_message, /IndexedDB could not open/);

    runtime.dispose();
  },
);

function createContendedLockManager() {
  let queuedGrant = null;
  return {
    async request(name, options, operation) {
      if (options.ifAvailable) return operation(null);
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        options.signal?.addEventListener("abort", abort, { once: true });
        queuedGrant = () => {
          options.signal?.removeEventListener("abort", abort);
          void Promise.resolve(operation({ name, mode: "exclusive" })).then(
            resolve,
            reject,
          );
        };
      });
    },
    grant() {
      assert.ok(queuedGrant, "No writer request is waiting");
      const grant = queuedGrant;
      queuedGrant = null;
      grant();
    },
  };
}

function createAvailableLockManager() {
  let markReleased;
  const released = new Promise((resolve) => {
    markReleased = resolve;
  });
  return {
    released,
    async request(name, options, operation) {
      assert.equal(options.ifAvailable, true);
      try {
        return await operation({ name, mode: "exclusive" });
      } finally {
        markReleased();
      }
    },
  };
}

function latestCatalog(events) {
  const event = events.findLast(
    (candidate) => candidate.type === "provider_catalog_snapshot",
  );
  assert.ok(event, "Missing provider catalog snapshot");
  return event.payload;
}

function coreEvent(type, payload, requestId) {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    ...(requestId === undefined ? {} : { request_id: requestId }),
    type,
    payload,
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

const defaultModel = {
  id: "researchbox-mock",
  name: "ResearchBox Mock",
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
    display_name: "ResearchBox",
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
