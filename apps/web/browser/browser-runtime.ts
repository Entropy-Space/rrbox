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
  BrowserCommandCoordinator,
  type CommandLockManager,
} from "./command-coordinator.ts";

export type BrowserRuntimeServices = {
  providerCatalog: ProviderCatalogService;
  modelTransport: ModelTransport;
  close(): void | Promise<void>;
};

export type BrowserRuntimeOptions<
  TServices extends BrowserRuntimeServices = BrowserRuntimeServices,
> = {
  host: WorkerHost;
  lockManager: CommandLockManager;
  createServices(): TServices;
  createCore(
    services: TServices,
    eventSink: CoreEventSink,
  ): CoreCommandHandler;
};

export type BrowserRuntimeHandle = {
  dispose(): Promise<void>;
};

type QueuedCommand = {
  command: ViewerCommand;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type PendingWorkspaceExport = {
  controller: AbortController;
  handling: Promise<void>;
};

export function startBrowserRuntime<TServices extends BrowserRuntimeServices>(
  options: BrowserRuntimeOptions<TServices>,
): BrowserRuntimeHandle {
  const runtimeController = new AbortController();
  const services = options.createServices();
  const coordinator = new RuntimeCoordinator(
    options.host,
    services.providerCatalog,
    new BrowserCommandCoordinator(options.lockManager, {
      signal: runtimeController.signal,
    }),
  );
  attachWorkerHost(options.host, coordinator);

  const unsubscribeCatalog = services.providerCatalog.subscribe(
    (snapshot) => coordinator.emitCatalogSnapshot(snapshot),
    true,
  );
  services.providerCatalog.startRefreshes();
  coordinator.emitLifecycle(
    "initializing_workspace",
    "Opening the local workspace.",
  );
  try {
    const core = options.createCore(
      services,
      (event) => coordinator.emitCoreEvent(event),
    );
    coordinator.attachCore(core);
  } catch (error) {
    const message = toErrorMessage(
      error,
      "The local workspace could not start.",
    );
    void coordinator.failWorkspace(new Error(message));
    coordinator.emitLifecycle("failed", message);
  }

  let disposal: Promise<void> | null = null;
  return {
    dispose() {
      if (disposal) return disposal;
      runtimeController.abort();
      unsubscribeCatalog();
      disposal = (async () => {
        try {
          await coordinator.dispose();
        } finally {
          await services.close();
        }
      })();
      return disposal;
    },
  };
}

class RuntimeCoordinator implements CoreCommandHandler {
  private readonly host: WorkerHost;
  private readonly providerCatalog: ProviderCatalogService;
  private readonly commandCoordinator: BrowserCommandCoordinator;
  private readonly queuedCommands: QueuedCommand[] = [];
  private readonly pendingWorkspaceExports = new Map<
    string,
    PendingWorkspaceExport
  >();
  private core: CoreCommandHandler | null = null;
  private coreDisposal: Promise<void> | null = null;
  private workspaceFailure: Error | null = null;
  private bootstrapPhase: "pending" | "running" | "complete" = "pending";
  private disposal: Promise<void> | null = null;
  private disposed = false;

  constructor(
    host: WorkerHost,
    providerCatalog: ProviderCatalogService,
    commandCoordinator: BrowserCommandCoordinator,
  ) {
    this.host = host;
    this.providerCatalog = providerCatalog;
    this.commandCoordinator = commandCoordinator;
  }

  handle(command: ViewerCommand): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("The browser runtime is closed."));
    }
    if (command.type === "provider_refresh") {
      return this.refreshProvider(command);
    }
    if (this.workspaceFailure) return Promise.reject(this.workspaceFailure);
    if (command.type === "workspace_export_cancel") {
      return this.cancelWorkspaceExport(command);
    }
    if (command.type === "workspace_export") {
      return this.handleWorkspaceExport(command);
    }
    return this.dispatchCoreCommand(command);
  }

  private dispatchCoreCommand(command: ViewerCommand): Promise<void> {
    if (
      command.type === "bootstrap" &&
      this.bootstrapPhase === "pending" &&
      this.core
    ) {
      return this.startBootstrap(command);
    }
    if (this.bootstrapPhase === "complete" && this.core) {
      return this.forwardToCore(command);
    }
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
    if (this.disposed) {
      void Promise.resolve(core.dispose?.()).catch(() => undefined);
      return;
    }
    if (this.workspaceFailure) throw this.workspaceFailure;
    if (this.core) throw new Error("The workspace core is already attached.");
    this.core = core;
    this.startQueuedBootstrap();
  }

  async failWorkspace(error: Error): Promise<void> {
    if (this.disposed || this.workspaceFailure) return;
    this.workspaceFailure = error;
    this.abortPendingWorkspaceExports();
    for (const pending of this.queuedCommands.splice(0)) {
      pending.reject(error);
    }
    await this.closeCore();
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

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.abortPendingWorkspaceExports();
    const error = new Error("The browser runtime was closed.");
    for (const pending of this.queuedCommands.splice(0)) {
      pending.reject(error);
    }
    this.disposal = this.closeCore();
    return this.disposal;
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
    const pendingExport =
      command.type === "workspace_export"
        ? this.pendingWorkspaceExports.get(command.request_id)
        : undefined;
    const handling = Promise.resolve().then(() =>
      this.commandCoordinator.run(
        command,
        () => core.handle(command),
        pendingExport
          ? { signal: pendingExport.controller.signal }
          : {},
      ),
    );
    return handling
      .catch((error: unknown) => {
        if (
          pendingExport?.controller.signal.aborted &&
          isAbortError(error)
        ) {
          return;
        }
        throw error;
      });
  }

  private handleWorkspaceExport(
    command: Extract<ViewerCommand, { type: "workspace_export" }>,
  ): Promise<void> {
    const existing = this.pendingWorkspaceExports.get(command.request_id);
    if (existing) return existing.handling;

    const pending: PendingWorkspaceExport = {
      controller: new AbortController(),
      handling: Promise.resolve(),
    };
    this.pendingWorkspaceExports.set(command.request_id, pending);
    pending.handling = this.dispatchCoreCommand(command).finally(() => {
      if (
        this.pendingWorkspaceExports.get(command.request_id) === pending
      ) {
        this.pendingWorkspaceExports.delete(command.request_id);
      }
    });
    return pending.handling;
  }

  private cancelWorkspaceExport(
    command: Extract<
      ViewerCommand,
      { type: "workspace_export_cancel" }
    >,
  ): Promise<void> {
    this.pendingWorkspaceExports
      .get(command.payload.target_request_id)
      ?.controller.abort(
        new DOMException(
          "The workspace export was canceled.",
          "AbortError",
        ),
      );
    return this.core
      ? this.forwardToCore(command)
      : Promise.resolve();
  }

  private abortPendingWorkspaceExports(): void {
    for (const pending of this.pendingWorkspaceExports.values()) {
      pending.controller.abort(
        new DOMException("The browser runtime was closed.", "AbortError"),
      );
    }
    this.pendingWorkspaceExports.clear();
  }

  private startBootstrap(
    command: Extract<ViewerCommand, { type: "bootstrap" }>,
  ): Promise<void> {
    this.bootstrapPhase = "running";
    const handling = this.forwardToCore(command);
    void handling.then(
      () => {
        if (this.disposed) return;
        this.bootstrapPhase = "complete";
        this.drainQueuedCommands();
      },
      (error: unknown) => {
        if (this.disposed) return;
        const message = toErrorMessage(
          error,
          "The local workspace could not start.",
        );
        void this.failWorkspace(new Error(message))
          .catch(() => undefined)
          .then(() => this.emitLifecycle("failed", message));
      },
    );
    return handling;
  }

  private startQueuedBootstrap(): void {
    if (this.bootstrapPhase !== "pending" || !this.core) return;
    const bootstrapIndex = this.queuedCommands.findIndex(
      (pending) => pending.command.type === "bootstrap",
    );
    if (bootstrapIndex === -1) return;
    const [pending] = this.queuedCommands.splice(bootstrapIndex, 1);
    if (!pending || pending.command.type !== "bootstrap") return;
    void this.startBootstrap(pending.command).then(
      pending.resolve,
      pending.reject,
    );
  }

  private drainQueuedCommands(): void {
    const queued = this.queuedCommands.splice(0);
    for (const pending of queued) {
      void this.forwardToCore(pending.command).then(
        pending.resolve,
        pending.reject,
      );
    }
  }

  private closeCore(): Promise<void> {
    if (this.coreDisposal) return this.coreDisposal;
    const core = this.core;
    this.core = null;
    this.coreDisposal = Promise.resolve().then(() => core?.dispose?.());
    return this.coreDisposal;
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

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError"
  );
}
