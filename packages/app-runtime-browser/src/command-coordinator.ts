import type { ViewerCommand } from "@researchbox/protocol";

const RESEARCHBOX_LOCK_NAMESPACE = "researchbox:v2";

export const RESEARCHBOX_LEGACY_WRITER_LOCK =
  "researchbox:core-writer:v1";
export const RESEARCHBOX_MAINTENANCE_LOCK =
  `${RESEARCHBOX_LOCK_NAMESPACE}:maintenance`;
export const RESEARCHBOX_CATALOG_LOCK =
  `${RESEARCHBOX_LOCK_NAMESPACE}:catalog`;

export type CommandLockManager = {
  request<T>(
    name: string,
    options: {
      mode: "exclusive" | "shared";
      signal?: AbortSignal;
    },
    operation: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T>;
};

type InMemoryLockRequest = {
  mode: "exclusive" | "shared";
  status: "queued" | "active" | "settled";
  signal: AbortSignal | undefined;
  abort_listener: (() => void) | null;
  run(lock: Lock, release: () => void): void;
  reject(reason: unknown): void;
};

type InMemoryLockState = {
  active_exclusive: boolean;
  active_shared: number;
  queue: InMemoryLockRequest[];
};

type CommandLockScope = {
  name: string;
  mode: "exclusive" | "shared";
};

/**
 * A process-local Web Locks substitute for runtimes without `navigator.locks`.
 *
 * Requests are granted in FIFO cohorts: consecutive shared requests may run
 * together, while an exclusive request prevents later readers from bypassing
 * it. This matches the coordination guarantees ResearchBox needs without
 * pretending to coordinate separate workers or processes.
 */
export class InMemoryCommandLockManager implements CommandLockManager {
  private readonly locks = new Map<string, InMemoryLockState>();

  request<T>(
    name: string,
    options: {
      mode: "exclusive" | "shared";
      signal?: AbortSignal;
    },
    operation: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    const state = this.locks.get(name) ?? createInMemoryLockState();
    this.locks.set(name, state);

    return new Promise<T>((resolve, reject) => {
      const request: InMemoryLockRequest = {
        mode: options.mode,
        status: "queued",
        signal,
        abort_listener: null,
        run(lock, release) {
          void Promise.resolve()
            .then(() => operation(lock))
            .then(
              (value) => {
                release();
                resolve(value);
              },
              (error: unknown) => {
                release();
                reject(error);
              },
            );
        },
        reject,
      };
      const abort = () => {
        this.abortQueuedRequest(
          name,
          state,
          request,
          signal ? abortReason(signal) : createAbortError(),
        );
      };
      request.abort_listener = abort;
      state.queue.push(request);
      signal?.addEventListener("abort", abort, { once: true });

      if (signal?.aborted) {
        abort();
        return;
      }
      this.drain(name, state);
    });
  }

  private abortQueuedRequest(
    name: string,
    state: InMemoryLockState,
    request: InMemoryLockRequest,
    reason: unknown,
  ): void {
    if (request.status !== "queued") return;
    const index = state.queue.indexOf(request);
    if (index === -1) return;

    state.queue.splice(index, 1);
    request.status = "settled";
    this.detachAbortListener(request);
    request.reject(reason);
    this.drain(name, state);
  }

  private drain(name: string, state: InMemoryLockState): void {
    if (state.active_exclusive) return;

    const first = state.queue[0];
    if (!first) {
      this.deleteIdleState(name, state);
      return;
    }

    if (first.mode === "exclusive") {
      if (state.active_shared > 0) return;
      state.queue.shift();
      this.grant(name, state, first);
      return;
    }

    while (
      !state.active_exclusive &&
      state.queue[0]?.mode === "shared"
    ) {
      const request = state.queue.shift();
      if (request) this.grant(name, state, request);
    }
  }

  private grant(
    name: string,
    state: InMemoryLockState,
    request: InMemoryLockRequest,
  ): void {
    request.status = "active";
    this.detachAbortListener(request);
    if (request.mode === "exclusive") {
      state.active_exclusive = true;
    } else {
      state.active_shared += 1;
    }

    const lock: Lock = Object.freeze({
      name,
      mode: request.mode,
    });
    let isReleased = false;
    const release = () => {
      if (isReleased) return;
      isReleased = true;
      request.status = "settled";
      if (request.mode === "exclusive") {
        state.active_exclusive = false;
      } else {
        state.active_shared -= 1;
      }
      this.drain(name, state);
    };

    request.run(lock, release);
  }

  private detachAbortListener(request: InMemoryLockRequest): void {
    if (!request.abort_listener) return;
    request.signal?.removeEventListener(
      "abort",
      request.abort_listener,
    );
    request.abort_listener = null;
  }

  private deleteIdleState(
    name: string,
    state: InMemoryLockState,
  ): void {
    if (
      state.active_exclusive ||
      state.active_shared !== 0 ||
      state.queue.length !== 0
    ) {
      return;
    }
    if (this.locks.get(name) === state) this.locks.delete(name);
  }
}

export class BrowserCommandCoordinator {
  private readonly lockManager: CommandLockManager;
  private readonly signal: AbortSignal | undefined;

  constructor(
    lockManager: CommandLockManager,
    options: { signal?: AbortSignal } = {},
  ) {
    this.lockManager = lockManager;
    this.signal = options.signal;
  }

  run<T>(
    command: ViewerCommand,
    operation: () => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.runScopes(
      commandLockScopes(command),
      operation,
      options.signal ?? this.signal,
    );
  }

  private runScopes<T>(
    scopes: readonly CommandLockScope[],
    operation: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const [scope, ...remaining] = scopes;
    if (!scope) return operation();

    signal?.throwIfAborted();
    return this.lockManager.request(
      scope.name,
      {
        mode: scope.mode,
        ...(signal ? { signal } : {}),
      },
      async (lock) => {
        if (!lock) {
          throw new Error(
            `Browser coordination lock ${scope.name} was not granted.`,
          );
        }
        signal?.throwIfAborted();
        return this.runScopes(remaining, operation, signal);
      },
    );
  }
}

export function projectCommandLock(projectId: string): string {
  return `${RESEARCHBOX_LOCK_NAMESPACE}:project:${encodeURIComponent(projectId)}`;
}

export function sessionRunCommandLock(
  projectId: string,
  sessionId: string | null,
): string {
  const sessionScope =
    sessionId === null ? "new-chat" : encodeURIComponent(sessionId);
  return `${projectCommandLock(projectId)}:session:${sessionScope}:run`;
}

function commandLockScopes(
  command: ViewerCommand,
): readonly CommandLockScope[] {
  switch (command.type) {
    case "bootstrap":
      return maintenanceExclusive();
    case "project_create":
    case "project_import":
      return catalogExclusive();
    case "project_delete":
      return coordinated(
        exclusive(projectCommandLock(command.payload.project_id)),
        exclusive(RESEARCHBOX_CATALOG_LOCK),
      );
    case "project_update":
      return coordinated(
        shared(projectCommandLock(command.payload.project_id)),
      );
    case "model_select":
    case "session_update":
    case "session_delete":
      return coordinated(
        shared(projectCommandLock(command.payload.project_id)),
        exclusive(
          sessionRunCommandLock(
            command.payload.project_id,
            command.payload.session_id,
          ),
        ),
      );
    case "prompt":
      return coordinated(
        shared(projectCommandLock(command.payload.project_id)),
        exclusive(
          sessionRunCommandLock(
            command.payload.project_id,
            command.payload.session_id,
          ),
        ),
      );
    case "input_draft_update":
      return coordinated(
        shared(projectCommandLock(command.payload.project_id)),
      );
    case "workspace_export":
    case "workspace_change_revert":
      return coordinated(
        exclusive(projectCommandLock(command.payload.project_id)),
      );
    case "workspace_change_read":
    case "fs_list":
    case "fs_read":
      return coordinated(
        shared(projectCommandLock(command.payload.project_id)),
      );
    case "project_select":
    case "new_chat":
    case "session_select":
      return [
        shared(projectCommandLock(command.payload.project_id)),
      ];
    case "provider_refresh":
    case "abort":
    case "summary_review_resolve":
    case "workspace_export_cancel":
      return [];
  }
}

function coordinated(
  ...scopes: readonly CommandLockScope[]
): readonly CommandLockScope[] {
  return [
    shared(RESEARCHBOX_LEGACY_WRITER_LOCK),
    shared(RESEARCHBOX_MAINTENANCE_LOCK),
    ...scopes,
  ];
}

function catalogExclusive(
  ...scopes: readonly CommandLockScope[]
): readonly CommandLockScope[] {
  return coordinated(
    exclusive(RESEARCHBOX_CATALOG_LOCK),
    ...scopes,
  );
}

function maintenanceExclusive(): readonly CommandLockScope[] {
  return [
    shared(RESEARCHBOX_LEGACY_WRITER_LOCK),
    exclusive(RESEARCHBOX_MAINTENANCE_LOCK),
  ];
}

function exclusive(name: string): CommandLockScope {
  return { name, mode: "exclusive" };
}

function shared(name: string): CommandLockScope {
  return { name, mode: "shared" };
}

function createInMemoryLockState(): InMemoryLockState {
  return {
    active_exclusive: false,
    active_shared: 0,
    queue: [],
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? createAbortError();
}

function createAbortError(): DOMException {
  return new DOMException("The lock request was aborted.", "AbortError");
}
