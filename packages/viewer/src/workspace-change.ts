import type { CoreEvent } from "@researchbox/protocol";

export type WorkspaceChangeSnapshot = Extract<
  CoreEvent,
  { type: "workspace_change_snapshot" }
>["payload"];

export type WorkspaceChangeRevertResult = Extract<
  CoreEvent,
  { type: "workspace_change_reverted" }
>["payload"];

type PendingWorkspaceChangeRequest =
  | {
      kind: "read";
      project_id: string;
      change_id: string;
      resolve: (snapshot: WorkspaceChangeSnapshot) => void;
      reject: (error: Error) => void;
    }
  | {
      kind: "revert";
      project_id: string;
      change_id: string;
      resolve: (result: WorkspaceChangeRevertResult) => void;
      reject: (error: Error) => void;
    };

export class WorkspaceChangeRequestError extends Error {
  readonly code: string;
  readonly project_id: string | undefined;

  constructor(
    code: string,
    message: string,
    projectId: string | undefined,
  ) {
    super(message);
    this.name = "WorkspaceChangeRequestError";
    this.code = code;
    this.project_id = projectId;
  }
}

export class WorkspaceChangeRequests {
  readonly #pending = new Map<string, PendingWorkspaceChangeRequest>();

  get size(): number {
    return this.#pending.size;
  }

  beginRead(
    requestId: string,
    projectId: string,
    changeId: string,
  ): Promise<WorkspaceChangeSnapshot> {
    return new Promise((resolve, reject) => {
      this.#add(requestId, {
        kind: "read",
        project_id: projectId,
        change_id: changeId,
        resolve,
        reject,
      });
    });
  }

  beginRevert(
    requestId: string,
    projectId: string,
    changeId: string,
  ): Promise<WorkspaceChangeRevertResult> {
    return new Promise((resolve, reject) => {
      this.#add(requestId, {
        kind: "revert",
        project_id: projectId,
        change_id: changeId,
        resolve,
        reject,
      });
    });
  }

  accept(event: CoreEvent): boolean {
    const requestId = event.request_id;
    if (!requestId) return false;
    const pending = this.#pending.get(requestId);
    if (!pending) return false;

    if (event.type === "error") {
      this.#pending.delete(requestId);
      pending.reject(
        new WorkspaceChangeRequestError(
          event.payload.code,
          event.payload.message,
          event.payload.project_id,
        ),
      );
      return true;
    }

    if (
      pending.kind === "read" &&
      event.type === "workspace_change_snapshot"
    ) {
      this.#pending.delete(requestId);
      if (
        event.payload.project_id !== pending.project_id ||
        event.payload.change.change_id !== pending.change_id
      ) {
        pending.reject(
          new Error(
            "The browser core returned a workspace change for the wrong scope.",
          ),
        );
        return true;
      }
      pending.resolve(event.payload);
      return true;
    }

    if (
      pending.kind === "revert" &&
      event.type === "workspace_change_reverted"
    ) {
      this.#pending.delete(requestId);
      if (
        event.payload.project_id !== pending.project_id ||
        event.payload.change_id !== pending.change_id
      ) {
        pending.reject(
          new Error(
            "The browser core reverted a workspace change for the wrong scope.",
          ),
        );
        return true;
      }
      pending.resolve(event.payload);
      return true;
    }

    if (
      event.type === "workspace_change_snapshot" ||
      event.type === "workspace_change_reverted"
    ) {
      this.#pending.delete(requestId);
      pending.reject(
        new Error(
          `The browser core returned an unexpected ${event.type} response.`,
        ),
      );
      return true;
    }

    return false;
  }

  reject(requestId: string, error: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    pending.reject(error);
  }

  rejectAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) request.reject(error);
  }

  #add(requestId: string, request: PendingWorkspaceChangeRequest): void {
    if (this.#pending.has(requestId)) {
      throw new Error(`Duplicate workspace change request: ${requestId}`);
    }
    this.#pending.set(requestId, request);
  }
}
