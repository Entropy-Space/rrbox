import {
  ProviderCatalogService,
  type CoreEventSink,
} from "@researchbox/agent-core";
import type { ModelTransport } from "@researchbox/model-transport";
import {
  PROTOCOL_VERSION,
  type CoreEvent,
  type CoreLifecyclePhase,
  type ViewerCommand,
} from "@researchbox/protocol";
import {
  attachWorkerHost,
  type CoreCommandHandler,
  type WorkerHost,
} from "@researchbox/runtime-browser";
import {
  withExclusiveWriterLease,
  type WriterLockManager,
} from "./writer-lease.ts";

export type BrowserRuntimeServices = {
  providerCatalog: ProviderCatalogService;
  modelTransport: ModelTransport;
  close(): void;
};

export type BrowserRuntimeOptions = {
  host: WorkerHost;
  lockManager: WriterLockManager;
  createServices(): BrowserRuntimeServices;
  createCore(
    services: BrowserRuntimeServices,
    eventSink: CoreEventSink,
  ): CoreCommandHandler;
};

export type BrowserRuntimeHandle = {
  dispose(): void;
};

type QueuedCommand = {
  command: ViewerCommand;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function startBrowserRuntime(
  options: BrowserRuntimeOptions,
): BrowserRuntimeHandle {
  const electionController = new AbortController();
  const lifetime = deferred<void>();
  const services = options.createServices();
  const coordinator = new RuntimeCoordinator(
    options.host,
    services.providerCatalog,
  );
  attachWorkerHost(options.host, coordinator);

  const unsubscribeCatalog = services.providerCatalog.subscribe(
    (snapshot) => coordinator.emitCatalogSnapshot(snapshot),
    true,
  );
  coordinator.emitLifecycle("electing", "Choosing the workspace writer.");
  services.providerCatalog.startRefreshes();

  void withExclusiveWriterLease(
    options.lockManager,
    async () => {
      coordinator.emitLifecycle(
        "initializing_workspace",
        "Opening the local workspace.",
      );
      const core = options.createCore(
        services,
        (event) => coordinator.emitCoreEvent(event),
      );
      coordinator.attachCore(core);
      await Promise.race([coordinator.waitForBootstrap(), lifetime.promise]);
      await lifetime.promise;
    },
    {
      signal: electionController.signal,
      onWaiting: () =>
        coordinator.emitLifecycle(
          "waiting_for_writer",
          "ResearchBox is active in another browser tab. This tab will connect automatically when it closes.",
        ),
    },
  ).catch((error: unknown) => {
    if (electionController.signal.aborted) return;
    const message = toErrorMessage(
      error,
      "The local workspace could not start.",
    );
    coordinator.failWorkspace(new Error(message));
    coordinator.emitLifecycle("failed", message);
  });

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      electionController.abort();
      lifetime.resolve();
      unsubscribeCatalog();
      coordinator.dispose();
      services.close();
    },
  };
}

class RuntimeCoordinator implements CoreCommandHandler {
  private readonly host: WorkerHost;
  private readonly providerCatalog: ProviderCatalogService;
  private readonly queuedCommands: QueuedCommand[] = [];
  private readonly bootstrapCompletion = deferred<void>();
  private core: CoreCommandHandler | null = null;
  private workspaceFailure: Error | null = null;
  private bootstrapStarted = false;
  private disposed = false;

  constructor(host: WorkerHost, providerCatalog: ProviderCatalogService) {
    this.host = host;
    this.providerCatalog = providerCatalog;
  }

  handle(command: ViewerCommand): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("The browser runtime is closed."));
    }
    if (command.type === "provider_refresh") {
      return this.refreshProvider(command);
    }
    if (this.workspaceFailure) return Promise.reject(this.workspaceFailure);
    if (this.core) return this.forwardToCore(command);
    return new Promise((resolve, reject) => {
      this.queuedCommands.push({ command, resolve, reject });
    });
  }

  reportHostError(
    code: "invalid_command" | "command_failed",
    message: string,
    requestId?: string,
  ): void {
    if (this.core) {
      this.core.reportHostError(code, message, requestId);
      return;
    }
    this.emitCoreEvent(
      eventEnvelope(
        "error",
        { code, message },
        requestId,
      ),
    );
  }

  attachCore(core: CoreCommandHandler): void {
    if (this.disposed) return;
    if (this.workspaceFailure) throw this.workspaceFailure;
    if (this.core) throw new Error("The workspace core is already attached.");
    this.core = core;
    const queued = this.queuedCommands.splice(0);
    for (const pending of queued) {
      void this.forwardToCore(pending.command).then(
        pending.resolve,
        pending.reject,
      );
    }
  }

  waitForBootstrap(): Promise<void> {
    return this.bootstrapCompletion.promise;
  }

  failWorkspace(error: Error): void {
    if (this.disposed || this.workspaceFailure) return;
    this.workspaceFailure = error;
    this.core = null;
    for (const pending of this.queuedCommands.splice(0)) {
      pending.reject(error);
    }
  }

  emitLifecycle(
    phase: CoreLifecyclePhase,
    statusMessage?: string,
  ): void {
    this.emitCoreEvent(
      eventEnvelope("core_lifecycle", {
        phase,
        ...(statusMessage === undefined
          ? {}
          : { status_message: statusMessage }),
      }),
    );
  }

  emitCatalogSnapshot(
    snapshot: ReturnType<ProviderCatalogService["snapshot"]>,
    requestId?: string,
  ): void {
    this.emitCoreEvent(
      eventEnvelope(
        "provider_catalog_snapshot",
        snapshot,
        requestId,
      ),
    );
  }

  emitCoreEvent(event: CoreEvent): void {
    if (!this.disposed) this.host.postMessage(event);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.core = null;
    const error = new Error("The browser runtime was closed.");
    for (const pending of this.queuedCommands.splice(0)) {
      pending.reject(error);
    }
  }

  private async refreshProvider(
    command: Extract<ViewerCommand, { type: "provider_refresh" }>,
  ): Promise<void> {
    const providerId = command.payload.provider_id;
    if (!this.providerCatalog.hasProvider(providerId)) {
      this.emitCoreEvent(
        eventEnvelope(
          "error",
          {
            code: "provider_not_found",
            message: "The requested model provider is not configured.",
          },
          command.request_id,
        ),
      );
      return;
    }
    await this.providerCatalog.refreshProvider(providerId, { force: true });
    this.emitCatalogSnapshot(
      this.providerCatalog.snapshot(),
      command.request_id,
    );
  }

  private forwardToCore(command: ViewerCommand): Promise<void> {
    const core = this.core;
    if (!core) {
      return Promise.reject(
        this.workspaceFailure ?? new Error("The workspace core is not ready."),
      );
    }
    const handling = Promise.resolve().then(() => core.handle(command));
    if (command.type === "bootstrap" && !this.bootstrapStarted) {
      this.bootstrapStarted = true;
      void handling.then(
        () => this.bootstrapCompletion.resolve(),
        (error: unknown) => this.bootstrapCompletion.reject(error),
      );
    }
    return handling;
  }
}

function eventEnvelope<T extends CoreEvent["type"]>(
  type: T,
  payload: Extract<CoreEvent, { type: T }>["payload"],
  requestId?: string,
): Extract<CoreEvent, { type: T }> {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    ...(requestId === undefined ? {} : { request_id: requestId }),
    type,
    payload,
  } as Extract<CoreEvent, { type: T }>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
