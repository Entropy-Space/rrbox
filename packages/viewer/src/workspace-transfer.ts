import type {
  CoreEvent,
  WorkspaceTransferFile,
} from "@researchbox/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export type WorkspaceExportSnapshot = Extract<
  CoreEvent,
  { type: "workspace_export_snapshot" }
>["payload"];

export type WorkspaceImportSelection = {
  suggested_name: string;
  files: WorkspaceTransferFile[];
} | null;

export type WorkspaceTransferAdapter = {
  pickWorkspaceImport: (options: {
    signal: AbortSignal;
  }) => WorkspaceImportSelection | Promise<WorkspaceImportSelection>;
  downloadWorkspaceExport: (options: {
    suggested_name: string;
    files: WorkspaceTransferFile[];
    signal: AbortSignal;
  }) => void | Promise<void>;
};

export type WorkspaceTransferNotice =
  | {
      kind: "progress";
      message: string;
      is_cancellable: boolean;
    }
  | {
      kind: "success" | "error";
      message: string;
    };

type UseWorkspaceTransferOptions = {
  adapter: WorkspaceTransferAdapter | undefined;
  importProject: (
    name: string,
    files: WorkspaceTransferFile[],
  ) => Promise<void>;
  exportWorkspace: (
    projectId: string,
    signal: AbortSignal,
  ) => Promise<WorkspaceExportSnapshot>;
  isDisabled: boolean;
};

export function useWorkspaceTransfer({
  adapter,
  importProject,
  exportWorkspace,
  isDisabled,
}: UseWorkspaceTransferOptions) {
  const [notice, setNotice] = useState<WorkspaceTransferNotice | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cancellableControllerRef = useRef<AbortController | null>(null);
  const suppressNextImportComposerFocusRef = useRef(false);
  const isPending = notice?.kind === "progress";

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      cancellableControllerRef.current = null;
      suppressNextImportComposerFocusRef.current = false;
    };
  }, []);

  const consumeImportFocusSuppression = useCallback(() => {
    if (!suppressNextImportComposerFocusRef.current) return false;
    suppressNextImportComposerFocusRef.current = false;
    return true;
  }, []);

  const cancelWorkspaceTransfer = useCallback(() => {
    const controller = cancellableControllerRef.current;
    if (!controller) return;
    cancellableControllerRef.current = null;
    if (abortControllerRef.current === controller) {
      abortControllerRef.current = null;
    }
    controller.abort();
    setNotice({
      kind: "success",
      message: "Workspace transfer canceled.",
    });
  }, []);

  const importWorkspace = useCallback(async (): Promise<void> => {
    if (isDisabled || !adapter || abortControllerRef.current) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    cancellableControllerRef.current = controller;
    setNotice({
      kind: "progress",
      message: "Choose a workspace to import…",
      is_cancellable: true,
    });

    try {
      const selection = await adapter.pickWorkspaceImport({
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!selection) {
        setNotice(null);
        return;
      }
      if (cancellableControllerRef.current === controller) {
        cancellableControllerRef.current = null;
      }

      const projectName = selection.suggested_name.trim();
      if (!projectName) {
        throw new Error("The imported workspace needs a project name.");
      }
      setNotice({
        kind: "progress",
        message: `Importing ${projectName}…`,
        is_cancellable: false,
      });
      suppressNextImportComposerFocusRef.current = true;
      await importProject(projectName, selection.files);
      if (controller.signal.aborted) return;
      setNotice({
        kind: "success",
        message: `${projectName} was imported.`,
      });
    } catch (error) {
      suppressNextImportComposerFocusRef.current = false;
      if (controller.signal.aborted) return;
      if (isAbortError(error)) {
        setNotice(null);
        return;
      }
      setNotice({
        kind: "error",
        message: transferErrorMessage(
          error,
          "The workspace could not be imported.",
        ),
      });
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (cancellableControllerRef.current === controller) {
        cancellableControllerRef.current = null;
      }
    }
  }, [adapter, importProject, isDisabled]);

  const exportProjectWorkspace = useCallback(
    async (projectId: string): Promise<void> => {
      if (isDisabled || !adapter || abortControllerRef.current) return;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      cancellableControllerRef.current = controller;
      setNotice({
        kind: "progress",
        message: "Preparing workspace export…",
        is_cancellable: true,
      });

      try {
        const snapshot = await exportWorkspace(projectId, controller.signal);
        if (controller.signal.aborted) return;
        cancellableControllerRef.current = controller;
        setNotice({
          kind: "progress",
          message: `Saving ${snapshot.project_name}…`,
          is_cancellable: true,
        });
        await adapter.downloadWorkspaceExport({
          suggested_name: snapshot.project_name,
          files: snapshot.files,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setNotice({
          kind: "success",
          message: `${snapshot.project_name} was exported.`,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (isAbortError(error)) {
          setNotice(null);
          return;
        }
        setNotice({
          kind: "error",
          message: transferErrorMessage(
            error,
            "The workspace could not be exported.",
          ),
        });
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (cancellableControllerRef.current === controller) {
          cancellableControllerRef.current = null;
        }
      }
    },
    [adapter, exportWorkspace, isDisabled],
  );

  return {
    notice,
    isPending,
    importWorkspace,
    exportProjectWorkspace,
    cancelWorkspaceTransfer,
    consumeImportFocusSuppression,
  };
}

type PendingWorkspaceTransfer =
  | {
      kind: "import";
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | {
      kind: "export";
      resolve: (snapshot: WorkspaceExportSnapshot) => void;
      reject: (error: Error) => void;
    };

export class WorkspaceTransferRequests {
  readonly #pending = new Map<string, PendingWorkspaceTransfer>();
  readonly #ignoredCanceledExports = new Set<string>();

  get size(): number {
    return this.#pending.size;
  }

  beginImport(requestId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#add(requestId, {
        kind: "import",
        resolve,
        reject,
      });
    });
  }

  beginExport(requestId: string): Promise<WorkspaceExportSnapshot> {
    return new Promise((resolve, reject) => {
      this.#add(requestId, {
        kind: "export",
        resolve,
        reject,
      });
    });
  }

  accept(event: CoreEvent): boolean {
    if (!event.request_id) return false;
    const pending = this.#pending.get(event.request_id);
    if (!pending) {
      if (
        this.#ignoredCanceledExports.has(event.request_id) &&
        (event.type === "workspace_export_snapshot" ||
          event.type === "error")
      ) {
        this.#ignoredCanceledExports.delete(event.request_id);
        return true;
      }
      return false;
    }

    if (event.type === "error") {
      this.#pending.delete(event.request_id);
      pending.reject(new Error(event.payload.message));
      return true;
    }
    if (pending.kind === "import" && event.type === "state_snapshot") {
      this.#pending.delete(event.request_id);
      pending.resolve();
      return true;
    }
    if (
      pending.kind === "export" &&
      event.type === "workspace_export_snapshot"
    ) {
      this.#pending.delete(event.request_id);
      pending.resolve(event.payload);
      return true;
    }
    return false;
  }

  reject(requestId: string, error: Error): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#pending.delete(requestId);
    pending.reject(error);
    return true;
  }

  cancelExport(requestId: string): boolean {
    const pending = this.#pending.get(requestId);
    if (pending?.kind !== "export") return false;
    this.#pending.delete(requestId);
    this.#ignoredCanceledExports.add(requestId);
    pending.reject(
      new DOMException("The workspace export was canceled.", "AbortError"),
    );
    return true;
  }

  rejectAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#ignoredCanceledExports.clear();
    for (const request of pending) request.reject(error);
  }

  #add(requestId: string, pending: PendingWorkspaceTransfer): void {
    if (
      this.#pending.has(requestId) ||
      this.#ignoredCanceledExports.has(requestId)
    ) {
      throw new Error(`Duplicate workspace transfer request: ${requestId}`);
    }
    this.#pending.set(requestId, pending);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function transferErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}
