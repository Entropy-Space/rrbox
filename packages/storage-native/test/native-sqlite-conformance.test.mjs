import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { before } from "node:test";
import {
  defineDurableWorkspaceBackendConformance,
  defineWorkspaceBackendConformance,
} from "@researchbox/vfs-testkit";
import {
  NativeStorageRpcClient,
  NativeWorkspaceBackend,
} from "../src/index.ts";
import {
  NativeDshrboxSessionBackend,
} from "../../dshrbox-session-persistence-native/src/index.ts";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const manifestPath = resolve(
  repositoryRoot,
  "apps/native/src-tauri/Cargo.toml",
);
const executableName =
  process.platform === "win32"
    ? "native-storage-harness.exe"
    : "native-storage-harness";
const cargoTargetDirectory = resolve(
  repositoryRoot,
  process.env.CARGO_TARGET_DIR ?? "apps/native/src-tauri/target",
);
const executablePath = resolve(
  cargoTargetDirectory,
  ...(process.env.CARGO_BUILD_TARGET
    ? [process.env.CARGO_BUILD_TARGET]
    : []),
  "debug",
  executableName,
);

before(async () => {
  await runProcess("cargo", [
    "build",
    "--quiet",
    "--manifest-path",
    manifestPath,
    "--bin",
    "native-storage-harness",
    "--features",
    "storage-test-harness",
  ]);
});

const nativeSqliteConformance = {
  name: "Native SQLite workspace backend",
  async create_backend({ seed_files }) {
    const root = await mkdtemp(
      resolve(tmpdir(), "researchbox-native-conformance-"),
    );
    let connection;
    try {
      connection = await openConnection(root, seed_files);
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }

    return {
      backend: connection.backend,
      async reopen() {
        await connection.close();
        connection = await openConnection(root, {});
        return connection.backend;
      },
      async close() {
        await connection.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  },
};

defineWorkspaceBackendConformance(nativeSqliteConformance);
defineDurableWorkspaceBackendConformance(nativeSqliteConformance);

test("Native SQLite create preserves lifecycle error precedence", async () => {
  const root = await mkdtemp(
    resolve(tmpdir(), "researchbox-native-precedence-"),
  );
  let connection;
  try {
    connection = await openConnection(root, {});
    await connection.backend.create("existing-project");
    const malformedOptions = {
      initial_files: [
        { path: "/invalid.txt", content: new Uint8Array() },
      ],
    };
    const nonArrayOptions = {
      initial_files: {},
    };
    await assert.rejects(
      connection.backend.create("existing-project", malformedOptions),
      (error) => error?.code === "already_exists",
    );
    await assert.rejects(
      connection.backend.create("missing-project", malformedOptions),
      (error) => error?.code === "invalid_path",
    );
    await assert.rejects(
      connection.backend.create("existing-project", nonArrayOptions),
      (error) => error?.code === "already_exists",
    );
    await assert.rejects(
      connection.backend.create("non-array-project", nonArrayOptions),
      (error) => error?.code === "invalid_path",
    );
    await assert.rejects(
      connection.backend.open("missing-project"),
      (error) => error?.code === "not_found",
    );
  } finally {
    await connection?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Native SQLite persists canonical DSH sessions across process reopen", async () => {
  const root = await mkdtemp(
    resolve(tmpdir(), "researchbox-native-dsh-persistence-"),
  );
  const projectId = "project-dsh";
  const sessionId = "session-dsh";
  let connection;
  try {
    connection = await openConnection(root, {});
    await connection.client.request({
      kind: "project_store_save",
      state: runtimeProjectState(projectId, sessionId),
      expected_revision: null,
    });
    const first = new NativeDshrboxSessionBackend(
      connection.client,
      projectId,
    );
    const header = {
      version: 0,
      id: sessionId,
      createdAt: 1_785_456_000_000,
    };
    const events = [
      {
        type: "turn/start",
        seq: 0,
        time: 1_785_456_000_001,
        data: { turn: 1 },
      },
      {
        type: "turn/end",
        seq: 1,
        time: 1_785_456_000_002,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ];
    await first.appendBatch(header, events, false);
    const firstRevision = await first.readStoredRevision(sessionId);
    assert.match(firstRevision, /^[0-9a-f]{32}:1$/u);

    await connection.close();
    connection = await openConnection(root, {});
    const reopened = new NativeDshrboxSessionBackend(
      connection.client,
      projectId,
    );
    assert.deepEqual(await reopened.loadStored(sessionId), {
      meta: header,
      events,
      revision: firstRevision,
    });
    assert.deepEqual(await reopened.loadStoredFrom(sessionId, 1), {
      meta: header,
      events: [events[1]],
    });
    assert.deepEqual(await reopened.list(), [header]);
    await reopened.deleteStored(sessionId);
    assert.equal(await reopened.loadStored(sessionId), undefined);
  } finally {
    await connection?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function openConnection(root, seedFiles) {
  const endpoint = new NativeStorageProcessEndpoint(root);
  const client = new NativeStorageRpcClient(endpoint);
  try {
    await client.ensureInitialized();
  } catch (error) {
    client.close();
    await endpoint.waitForExit();
    throw error;
  }
  return {
    client,
    backend: new NativeWorkspaceBackend(client, {
      default_initial_files: seedFiles,
    }),
    async close() {
      client.close();
      await endpoint.waitForExit();
    },
  };
}

function runtimeProjectState(projectId, sessionId) {
  return {
    schema_version: 4,
    state_revision: 1,
    active_project_id: projectId,
    active_session_id: sessionId,
    projects: [{
      project_id: projectId,
      name: "DSH project",
      created_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z",
      last_session_id: sessionId,
      new_chat_draft: "",
      new_chat_model: {
        provider_id: "researchbox",
        model_id: "researchbox-mock",
      },
      new_chat_reasoning_effort: "default",
    }],
    sessions: [{
      session_id: sessionId,
      project_id: projectId,
      title: "DSH session",
      title_is_custom: false,
      created_at: "2026-08-31T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z",
      selected_model: {
        provider_id: "researchbox",
        model_id: "researchbox-mock",
      },
      reasoning_effort: "default",
    }],
    documents: [{
      format_version: 6,
      session_id: sessionId,
      project_id: projectId,
      input_draft: "",
      runtime_id: "dsh",
      message_count: 0,
    }],
  };
}

class NativeStorageProcessEndpoint {
  #child;
  #listeners = {
    message: new Set(),
    messageerror: new Set(),
  };
  #stderr = "";
  #stdoutBuffer = "";
  #closing = false;
  #exit;

  constructor(root) {
    this.#child = spawn(executablePath, ["--root", root], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#exit = new Promise((resolveExit) => {
      this.#child.once("close", (code, signal) => {
        if (!this.#closing) {
          this.#dispatchError(
            new Error(
              `Native storage harness exited unexpectedly (${formatExit(code, signal)}).${this.#diagnostic()}`,
            ),
          );
        }
        resolveExit();
      });
    });
    this.#child.once("error", (error) => {
      this.#dispatchError(error);
    });
    this.#child.stdin.on("error", (error) => {
      if (!this.#closing) this.#dispatchError(error);
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => {
      this.#handleStdout(chunk);
    });
    this.#child.stdout.on("end", () => {
      if (this.#stdoutBuffer.trim().length > 0) {
        this.#dispatchError(
          new Error(
            `Native storage harness returned an incomplete response: ${this.#stdoutBuffer}`,
          ),
        );
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk;
    });
  }

  postMessage(message) {
    if (this.#closing || this.#child.stdin.destroyed) {
      throw new Error("The native storage harness is closed.");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  addEventListener(type, listener) {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners[type].delete(listener);
  }

  start() {}

  close() {
    if (this.#closing) return;
    this.#closing = true;
    this.#child.stdin.end();
  }

  async waitForExit() {
    const timeout = setTimeout(() => {
      this.#child.kill();
    }, 5_000);
    timeout.unref?.();
    try {
      await this.#exit;
    } finally {
      clearTimeout(timeout);
    }
  }

  #handleStdout(chunk) {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      try {
        const data = JSON.parse(line);
        for (const listener of this.#listeners.message) {
          listener({ data });
        }
      } catch (error) {
        this.#dispatchError(
          new Error(
            `Native storage harness returned invalid JSON: ${line}.${this.#diagnostic()}`,
            { cause: error },
          ),
        );
      }
    }
  }

  #dispatchError(error) {
    for (const listener of this.#listeners.messageerror) {
      listener({ data: error });
    }
  }

  #diagnostic() {
    const stderr = this.#stderr.trim();
    return stderr.length === 0 ? "" : `\n${stderr}`;
  }
}

function runProcess(command, arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${command} failed (${formatExit(code, signal)}).${stderr.trim().length === 0 ? "" : `\n${stderr.trim()}`}`,
        ),
      );
    });
  });
}

function formatExit(code, signal) {
  if (signal) return `signal ${signal}`;
  return `exit code ${code ?? "unknown"}`;
}
