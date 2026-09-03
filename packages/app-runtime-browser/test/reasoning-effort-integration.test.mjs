import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleModelTransport } from "@researchbox/model-transport";
import { MemoryProjectStore, parseProjectStoreState } from "@researchbox/project-store";
import { buildComposerModelControlSnapshot, formatComposerEffortLabel } from "../../viewer/src/composer-model-control.ts";
import { createCommand } from "@researchbox/protocol";
import {
  attachLlmWorkerHost,
  WorkerCoreTransport,
} from "@researchbox/runtime-browser";
import {
  createResearchBoxProviderDefinitions,
  startResearchBoxCoreWorker,
} from "@researchbox/app-runtime-browser/core-worker";
import { InMemoryCommandLockManager } from "@researchbox/app-runtime-browser/command-coordinator";
import {
  MemoryDshrboxSessionBackend,
} from "@dshrbox/session-persistence";
import {
  DshrboxSessionRuntimeProvider,
} from "@dshrbox/session-runtime";
import {
  MemoryFileSystem,
  MemoryWorkspaceBackend,
} from "@researchbox/vfs";

test("provider-defined efforts survive discovery, UI, persistence, DSH, and request serialization", async () => {
  const options = [
    { id: "ultra", display_name: "Think deeply", description: "A provider-defined budget." },
    { id: "vendor:adaptive-v2", display_name: "Adaptive" },
    { id: "high", display_name: "High" },
  ];
  let advertisedOptions = options;
  const chatRequests = [];
  const chatHeaders = [];
  const modelTransport = new OpenAiCompatibleModelTransport({
    provider_id: "local-openai",
    provider_display_name: "Local OpenAI",
    models_endpoint: "/models",
    chat_completions_endpoint: "/chat/completions",
    send_session_affinity_headers: true,
    fetch_request: async (input, init) => {
      if (input === "/models") {
        return Response.json({
          object: "list",
          data: [{
            id: "fixture-reasoning-model",
            x_tokn_router: {
              name: "Fixture reasoning model",
              capabilities: {
                reasoning: true,
                reasoning_efforts: advertisedOptions,
                toolcall: true,
              },
              limit: {
                context: 128_000,
                output: 8_192,
              },
            },
          }],
        });
      }

      assert.equal(input, "/chat/completions");
      chatHeaders.push(new Headers(init.headers));
      chatRequests.push(JSON.parse(init.body));
      return new Response([
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Done\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
      ].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const llmWorkerPair = createWorkerPair();
  const llmAttachment = attachLlmWorkerHost(
    llmWorkerPair.host,
    modelTransport,
    {
      listModels(providerId, signal) {
        assert.equal(providerId, "local-openai");
        return modelTransport.listModels(signal);
      },
    },
  );
  const coreWorkerPair = createWorkerPair();
  const projectStore = new MemoryProjectStore();
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const runtime = startResearchBoxCoreWorker({
    host: coreWorkerPair.host,
    lock_manager: new InMemoryCommandLockManager(),
    create_model_worker: () => llmWorkerPair.worker,
    create_storage_services: () => ({
      projectStore,
      workspaceBackend: new MemoryWorkspaceBackend(
        () => new MemoryFileSystem({ "/README.md": "# Test" }),
      ),
      sessionRuntimeProvider: new DshrboxSessionRuntimeProvider({
        session_backend: sessionBackend,
        max_parallel_tool_calls: 1,
      }),
      close() {},
    }),
    providers: createResearchBoxProviderDefinitions({
      include_local_openai: true,
    }),
  });
  const coreTransport = new WorkerCoreTransport(coreWorkerPair.worker);
  const events = [];
  const failures = [];
  coreTransport.subscribe(
    (event) => events.push(event),
    (failure) => failures.push(failure),
  );

  try {
    const bootstrap = createCommand("bootstrap", {});
    coreTransport.send(bootstrap);
    const initialState = await waitForState(events, bootstrap.request_id);
    await waitForCondition(() =>
      events.some(
        (event) =>
          event.type === "provider_catalog_snapshot" &&
          event.payload.providers.some(
            (provider) =>
              provider.provider_id === "local-openai" &&
              provider.availability === "ready" &&
              provider.models.some(
                (model) => model.model_id === "fixture-reasoning-model",
              ),
          ),
      ),
    );

    const modelSelect = createCommand("model_select", {
      project_id: initialState.active_project_id,
      session_id: null,
      provider_id: "local-openai",
      model_id: "fixture-reasoning-model",
    });
    coreTransport.send(modelSelect);
    await waitForState(events, modelSelect.request_id);

    const effortSelect = createCommand("reasoning_effort_select", {
      project_id: initialState.active_project_id,
      session_id: null,
      reasoning_effort: "ultra",
    });
    coreTransport.send(effortSelect);
    const selectedState = await waitForState(events, effortSelect.request_id);
    assert.equal(selectedState.active_reasoning_effort, "ultra");
    const picker = buildComposerModelControlSnapshot(selectedState.providers, selectedState.active_model, "ultra");
    assert.deepEqual(picker.effort_options.map((option) => option.suggestionId), ["default", ...options.map((option) => option.id)]);
    assert.equal(formatComposerEffortLabel("ultra", picker.effort_options), "Think deeply");
    assert.equal(picker.effort_options[1].description, options[0].description);
    assert.equal(picker.effort_options[1].isSelected, true);

    // Even familiar levels must be rejected when this model doesn't advertise them.
    for (const reasoning_effort of ["low", "not-advertised"]) {
      const invalid = createCommand("reasoning_effort_select", {
        project_id: initialState.active_project_id, session_id: null, reasoning_effort,
      });
      coreTransport.send(invalid);
      await waitForEvent(events, invalid.request_id, "error");
      assert.equal(events.find((event) => event.request_id === invalid.request_id && event.type === "error").payload.code, "reasoning_effort_unavailable");
    }

    const prompt = createCommand("prompt", {
      project_id: initialState.active_project_id,
      session_id: null,
      text: "Think carefully.",
    });
    coreTransport.send(prompt);
    await waitForCondition(() => chatRequests.length > 0);
    const promptedState = await waitForState(events, prompt.request_id);

    assert.equal(chatRequests[0].model, "fixture-reasoning-model");
    assert.equal(chatRequests[0].reasoning_effort, "ultra");

    const activeSessionId = promptedState.active_session_id;
    assert.ok(activeSessionId);
    const persisted = await projectStore.load();
    assert.equal(persisted.documents[0].runtime_id, "dsh");
    const reloaded = parseProjectStoreState(JSON.parse(JSON.stringify(persisted)));
    assert.equal(reloaded.projects[0].new_chat_reasoning_effort, "ultra");
    assert.equal(reloaded.sessions[0].reasoning_effort, "ultra");
    assert.deepEqual(
      (await sessionBackend.list()).map((header) => String(header.id)),
      [activeSessionId],
    );
    assert.equal(chatHeaders[0].get("session_id"), activeSessionId);
    assert.equal(chatHeaders[0].get("x-client-request-id"), activeSessionId);
    assert.equal(chatHeaders[0].get("x-session-affinity"), activeSessionId);

    const resetEffort = createCommand("reasoning_effort_select", {
      project_id: initialState.active_project_id,
      session_id: activeSessionId,
      reasoning_effort: "default",
    });
    coreTransport.send(resetEffort);
    await waitForState(events, resetEffort.request_id);
    const automaticPrompt = createCommand("prompt", {
      project_id: initialState.active_project_id,
      session_id: activeSessionId,
      text: "Use the provider default.",
    });
    coreTransport.send(automaticPrompt);
    await waitForCondition(() => chatRequests.length === 2);
    await waitForState(events, automaticPrompt.request_id);
    assert.equal(Object.hasOwn(chatRequests[1], "reasoning_effort"), false);

    const commandDraft = createCommand("input_draft_update", {
      project_id: initialState.active_project_id,
      session_id: activeSessionId,
      input_draft: "/reasoning high",
    });
    coreTransport.send(commandDraft);
    await waitForEvent(events, commandDraft.request_id, "input_draft_saved");

    const sessionEffortSelect = createCommand("reasoning_effort_select", {
      project_id: initialState.active_project_id,
      session_id: activeSessionId,
      reasoning_effort: "high",
    });
    const clearCommandDraft = createCommand("input_draft_update", {
      project_id: initialState.active_project_id,
      session_id: activeSessionId,
      input_draft: "",
    });
    coreTransport.send(sessionEffortSelect);
    coreTransport.send(clearCommandDraft);
    const sessionSelectedState = await waitForState(
      events,
      sessionEffortSelect.request_id,
    );
    await waitForEvent(
      events,
      clearCommandDraft.request_id,
      "input_draft_saved",
    );
    assert.equal(sessionSelectedState.active_reasoning_effort, "high");

    const followUp = createCommand("prompt", {
      project_id: initialState.active_project_id,
      session_id: activeSessionId,
      text: "Think carefully again.",
    });
    coreTransport.send(followUp);
    await waitForCondition(() => chatRequests.length > 2);
    await waitForState(events, followUp.request_id);

    assert.equal(chatRequests[2].model, "fixture-reasoning-model");
    assert.equal(chatRequests[2].reasoning_effort, "high");
    assert.equal(chatHeaders[2].get("session_id"), activeSessionId);
    assert.equal(chatHeaders[2].get("x-client-request-id"), activeSessionId);
    assert.equal(chatHeaders[2].get("x-session-affinity"), activeSessionId);

    advertisedOptions = [];
    const refresh = createCommand("provider_refresh", { provider_id: "local-openai" });
    coreTransport.send(refresh);
    await waitForCondition(() => events.some((event) => event.type === "provider_catalog_snapshot" &&
      event.payload.providers.some((provider) => provider.provider_id === "local-openai" && provider.availability === "ready" &&
        provider.models[0]?.reasoning_efforts.length === 0)));
    const stalePrompt = createCommand("prompt", {
      project_id: initialState.active_project_id, session_id: activeSessionId, text: "Do not send a stale effort.",
    });
    coreTransport.send(stalePrompt);
    await waitForEvent(events, stalePrompt.request_id, "error");
    assert.equal(events.find((event) => event.request_id === stalePrompt.request_id && event.type === "error").payload.code, "reasoning_effort_unavailable");
    assert.equal(chatRequests.length, 3);
    assert.deepEqual(failures, []);
  } finally {
    coreTransport.close();
    await runtime.dispose();
    llmAttachment.close();
  }
});

function createWorkerPair() {
  const detached = createDetachedWorker();
  const host = {
    onmessage: null,
    postMessage(event) {
      queueMicrotask(() => detached.emitMessage(structuredClone(event)));
    },
  };
  detached.forwardCommand((command) => {
    queueMicrotask(() => {
      host.onmessage?.(
        new MessageEvent("message", { data: structuredClone(command) }),
      );
    });
  });
  return { host, ...detached };
}

function createDetachedWorker() {
  const listeners = new Map([
    ["message", new Set()],
    ["error", new Set()],
    ["messageerror", new Set()],
  ]);
  let commandListener = () => undefined;
  return {
    worker: {
      addEventListener(type, listener) {
        listeners.get(type)?.add(listener);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      postMessage(command) {
        commandListener(structuredClone(command));
      },
      terminate() {},
    },
    emitMessage(data) {
      for (const listener of listeners.get("message") ?? []) {
        listener(new MessageEvent("message", { data }));
      }
    },
    forwardCommand(listener) {
      commandListener = listener;
    },
  };
}

async function waitForState(events, requestId) {
  await waitForCondition(() =>
    events.some(
      (event) =>
        (event.type === "state_snapshot" || event.type === "ready") &&
        event.request_id === requestId,
    ),
  );
  const event = events.findLast(
    (candidate) =>
      (candidate.type === "state_snapshot" || candidate.type === "ready") &&
      candidate.request_id === requestId,
  );
  return event.payload.state;
}

async function waitForEvent(events, requestId, type) {
  await waitForCondition(() =>
    events.some(
      (event) =>
        event.type === type && event.request_id === requestId,
    ),
  );
}

async function waitForCondition(condition) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the browser runtime.");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}
