import assert from "node:assert/strict";
import test from "node:test";
import { createCommand } from "@researchbox/protocol";
import {
  BrowserCommandCoordinator,
  RESEARCHBOX_CATALOG_LOCK,
  RESEARCHBOX_LEGACY_WRITER_LOCK,
  RESEARCHBOX_MAINTENANCE_LOCK,
  projectCommandLock,
  sessionRunCommandLock,
} from "@researchbox/app-runtime-browser/command-coordinator";

test("bootstrap maintenance blocks catalog changes but not providers", async () => {
  const lockManager = new TestLockManager();
  const coordinator = new BrowserCommandCoordinator(lockManager);
  const bootstrapGate = deferred();
  const started = [];

  const bootstrap = coordinator.run(
    createCommand("bootstrap", {}),
    async () => {
      started.push("bootstrap");
      await bootstrapGate.promise;
    },
  );
  const projectCreate = coordinator.run(
    createCommand("project_create", { name: "Second project" }),
    async () => {
      started.push("project_create");
    },
  );
  const providerRefresh = coordinator.run(
    createCommand("provider_refresh", { provider_id: "local-openai" }),
    async () => {
      started.push("provider_refresh");
    },
  );

  await flushTasks();
  assert.equal(started.includes("bootstrap"), true);
  assert.equal(started.includes("provider_refresh"), true);
  assert.equal(started.includes("project_create"), false);
  assert.deepEqual(
    lockManager.requests.filter(
      (request) => request.name === RESEARCHBOX_CATALOG_LOCK,
    ),
    [],
  );
  assert.deepEqual(
    lockManager.requests.filter(
      (request) => request.name === RESEARCHBOX_MAINTENANCE_LOCK,
    ),
    [
      { name: RESEARCHBOX_MAINTENANCE_LOCK, mode: "exclusive" },
      { name: RESEARCHBOX_MAINTENANCE_LOCK, mode: "shared" },
    ],
  );
  assert.deepEqual(
    lockManager.requests.filter(
      (request) => request.name === RESEARCHBOX_LEGACY_WRITER_LOCK,
    ),
    [
      { name: RESEARCHBOX_LEGACY_WRITER_LOCK, mode: "shared" },
      { name: RESEARCHBOX_LEGACY_WRITER_LOCK, mode: "shared" },
    ],
  );

  bootstrapGate.resolve();
  await Promise.all([bootstrap, projectCreate, providerRefresh]);
  assert.equal(started.includes("project_create"), true);
  assert.deepEqual(
    lockManager.requests.filter(
      (request) => request.name === RESEARCHBOX_CATALOG_LOCK,
    ),
    [{ name: RESEARCHBOX_CATALOG_LOCK, mode: "exclusive" }],
  );
  assert.equal(
    started.indexOf("project_create") > started.indexOf("bootstrap"),
    true,
  );
});

test("same-session prompts serialize without blocking other sessions", async () => {
  const lockManager = new TestLockManager();
  const coordinator = new BrowserCommandCoordinator(lockManager);
  const firstGate = deferred();
  const started = [];

  const first = coordinator.run(
    promptCommand("session-1"),
    async () => {
      started.push("first");
      await firstGate.promise;
    },
  );
  const second = coordinator.run(
    promptCommand("session-1"),
    async () => {
      started.push("second");
    },
  );
  const otherSession = coordinator.run(
    promptCommand("session-2"),
    async () => {
      started.push("other_session");
    },
  );

  await flushTasks();
  assert.deepEqual(started, ["first", "other_session"]);
  assert.equal(
    lockManager.requests.filter(
      (request) =>
        request.name === sessionRunCommandLock("project-1", "session-1"),
    ).length,
    2,
  );

  firstGate.resolve();
  await Promise.all([first, second, otherSession]);
  assert.deepEqual(started, ["first", "other_session", "second"]);
});

test("project deletion waits for project runs but abort remains lock-free", async () => {
  const lockManager = new TestLockManager();
  const coordinator = new BrowserCommandCoordinator(lockManager);
  const promptGate = deferred();
  const started = [];

  const prompt = coordinator.run(
    promptCommand("session-1"),
    async () => {
      started.push("prompt");
      await promptGate.promise;
    },
  );
  const deletion = coordinator.run(
    createCommand("project_delete", { project_id: "project-1" }),
    async () => {
      started.push("delete");
    },
  );
  const abort = coordinator.run(
    createCommand("abort", {
      project_id: "project-1",
      session_id: "session-1",
    }),
    async () => {
      started.push("abort");
    },
  );

  await waitForCondition(
    () =>
      started.includes("prompt") &&
      started.includes("abort") &&
      lockManager.requests.some(
        (request) =>
          request.name === projectCommandLock("project-1") &&
          request.mode === "exclusive",
      ),
  );
  assert.equal(started.includes("delete"), false);

  promptGate.resolve();
  await Promise.all([prompt, deletion, abort]);
  assert.equal(started.includes("delete"), true);
  assert.equal(started.indexOf("delete") > started.indexOf("prompt"), true);
});

test("project deletion does not hold the catalog while waiting for its project", async () => {
  const lockManager = new TestLockManager();
  const coordinator = new BrowserCommandCoordinator(lockManager);
  const promptGate = deferred();
  const started = [];

  const prompt = coordinator.run(
    promptCommand("session-1"),
    async () => {
      started.push("prompt");
      await promptGate.promise;
    },
  );
  const deletion = coordinator.run(
    createCommand("project_delete", { project_id: "project-1" }),
    async () => started.push("delete"),
  );
  const creation = coordinator.run(
    createCommand("project_create", { name: "Other project" }),
    async () => started.push("create"),
  );

  await waitForCondition(
    () =>
      started.includes("prompt") &&
      started.includes("create") &&
      lockManager.requests.some(
        (request) =>
          request.name === projectCommandLock("project-1") &&
          request.mode === "exclusive",
      ),
  );
  assert.equal(started.includes("delete"), false);

  promptGate.resolve();
  await Promise.all([prompt, deletion, creation]);
  assert.equal(started.includes("delete"), true);
});

test("project deletion does not wait for a run in another project", async () => {
  const lockManager = new TestLockManager();
  const coordinator = new BrowserCommandCoordinator(lockManager);
  const promptGate = deferred();
  const started = [];

  const prompt = coordinator.run(
    promptCommand("session-1"),
    async () => {
      started.push("prompt");
      await promptGate.promise;
    },
  );
  const deletion = coordinator.run(
    createCommand("project_delete", { project_id: "project-2" }),
    async () => started.push("delete_other_project"),
  );

  await waitForCondition(
    () =>
      started.includes("prompt") &&
      started.includes("delete_other_project"),
  );
  promptGate.resolve();
  await Promise.all([prompt, deletion]);
});

test("tab-local navigation takes only a shared project lifecycle gate", async () => {
  const lockManager = new TestLockManager();
  const coordinator = new BrowserCommandCoordinator(lockManager);
  const handled = [];

  await coordinator.run(
    createCommand("project_select", { project_id: "project-1" }),
    async () => handled.push("project_select"),
  );
  await coordinator.run(
    createCommand("new_chat", { project_id: "project-1" }),
    async () => handled.push("new_chat"),
  );
  await coordinator.run(
    createCommand("session_select", {
      project_id: "project-1",
      session_id: "session-1",
    }),
    async () => handled.push("session_select"),
  );

  assert.deepEqual(handled, [
    "project_select",
    "new_chat",
    "session_select",
  ]);
  assert.deepEqual(lockManager.requests, [
    { name: projectCommandLock("project-1"), mode: "shared" },
    { name: projectCommandLock("project-1"), mode: "shared" },
    { name: projectCommandLock("project-1"), mode: "shared" },
  ]);
});

test("workspace reads share a project gate and mutations take it exclusively", async () => {
  const lockManager = new TestLockManager();
  const coordinator = new BrowserCommandCoordinator(lockManager);
  const readGate = deferred();
  const started = [];

  const read = coordinator.run(
    createCommand("fs_read", {
      project_id: "project-1",
      path: "/README.md",
    }),
    async () => {
      started.push("read");
      await readGate.promise;
    },
  );
  const otherProjectRead = coordinator.run(
    createCommand("fs_list", {
      project_id: "project-2",
      path: "/",
    }),
    async () => started.push("other_project_read"),
  );
  const revert = coordinator.run(
    createCommand("workspace_change_revert", {
      project_id: "project-1",
      change_id: "change-1",
    }),
    async () => started.push("revert"),
  );

  await flushTasks();
  assert.deepEqual(started, ["read", "other_project_read"]);
  readGate.resolve();
  await Promise.all([read, otherProjectRead, revert]);
  assert.deepEqual(started, ["read", "other_project_read", "revert"]);
});

test("new commands share the legacy gate while old exclusive writers drain", async () => {
  const lockManager = new TestLockManager();
  const coordinator = new BrowserCommandCoordinator(lockManager);
  const legacyGate = deferred();
  const started = [];
  const legacyWriter = lockManager.request(
    RESEARCHBOX_LEGACY_WRITER_LOCK,
    { mode: "exclusive" },
    () => legacyGate.promise,
  );
  await flushTasks();

  const prompt = coordinator.run(
    promptCommand("session-1"),
    async () => started.push("prompt"),
  );
  const providerRefresh = coordinator.run(
    createCommand("provider_refresh", {
      provider_id: "local-openai",
    }),
    async () => started.push("provider_refresh"),
  );
  await flushTasks();

  assert.deepEqual(started, ["provider_refresh"]);
  legacyGate.resolve();
  await Promise.all([legacyWriter, prompt, providerRefresh]);
  assert.deepEqual(started, ["provider_refresh", "prompt"]);
});

test("disposing coordination aborts commands waiting for a lock", async () => {
  const lockManager = new TestLockManager();
  const firstCoordinator = new BrowserCommandCoordinator(lockManager);
  const controller = new AbortController();
  const waitingCoordinator = new BrowserCommandCoordinator(lockManager, {
    signal: controller.signal,
  });
  const firstGate = deferred();

  const first = firstCoordinator.run(
    createCommand("bootstrap", {}),
    () => firstGate.promise,
  );
  const waiting = waitingCoordinator.run(
    createCommand("bootstrap", {}),
    async () => undefined,
  );
  await flushTasks();

  controller.abort();
  await assert.rejects(waiting, (error) => error?.name === "AbortError");
  firstGate.resolve();
  await first;
});

function promptCommand(sessionId) {
  return createCommand("prompt", {
    project_id: "project-1",
    session_id: sessionId,
    text: "Hello",
  });
}

class TestLockManager {
  requests = [];
  #locks = new Map();

  request(name, options, operation) {
    this.requests.push({ name, mode: options.mode });
    const state = this.#locks.get(name) ?? {
      active_exclusive: false,
      active_shared: 0,
      queue: [],
    };
    this.#locks.set(name, state);

    return new Promise((resolve, reject) => {
      const request = {
        mode: options.mode,
        operation,
        resolve,
        reject,
        signal: options.signal,
        abort: null,
      };
      request.abort = () => {
        const index = state.queue.indexOf(request);
        if (index === -1) return;
        state.queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
        this.#drain(name, state);
      };
      state.queue.push(request);
      if (request.signal?.aborted) {
        request.abort();
        return;
      }
      request.signal?.addEventListener("abort", request.abort, { once: true });
      this.#drain(name, state);
    });
  }

  #drain(name, state) {
    if (state.active_exclusive || state.queue.length === 0) return;
    const first = state.queue[0];
    if (first.mode === "exclusive") {
      if (state.active_shared > 0) return;
      state.queue.shift();
      state.active_exclusive = true;
      this.#start(name, state, first);
      return;
    }

    while (state.queue[0]?.mode === "shared" && !state.active_exclusive) {
      const request = state.queue.shift();
      state.active_shared += 1;
      this.#start(name, state, request);
    }
  }

  #start(name, state, request) {
    request.signal?.removeEventListener("abort", request.abort);
    void Promise.resolve()
      .then(() => request.operation({ name, mode: request.mode }))
      .then(request.resolve, request.reject)
      .finally(() => {
        if (request.mode === "exclusive") {
          state.active_exclusive = false;
        } else {
          state.active_shared -= 1;
        }
        this.#drain(name, state);
      });
  }
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

function flushTasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForCondition(condition) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await flushTasks();
  }
  assert.fail("Timed out waiting for coordinated browser commands.");
}
