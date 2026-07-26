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

type CommandLockScope = {
  name: string;
  mode: "exclusive" | "shared";
};

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
