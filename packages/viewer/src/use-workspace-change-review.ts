import type { WorkspaceChangeSummary } from "@researchbox/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  WorkspaceChangeRevertResult,
  WorkspaceChangeSnapshot,
} from "./workspace-change.ts";

type WorkspaceChangeSelection = {
  project_id: string;
  session_id: string | null;
  change_id: string;
  summary: WorkspaceChangeSummary;
};

export type WorkspaceChangeReviewView =
  | { phase: "idle" }
  | {
      phase: "loading";
      selection: WorkspaceChangeSelection;
    }
  | {
      phase: "error";
      selection: WorkspaceChangeSelection;
      message: string;
    }
  | {
      phase: "ready";
      selection: WorkspaceChangeSelection;
      snapshot: WorkspaceChangeSnapshot;
      is_reverting: boolean;
      is_confirming: boolean;
      action_error: string | null;
    };

export type WorkspaceChangeReviewController = {
  view: WorkspaceChangeReviewView;
  return_focus_ref: RefObject<HTMLElement | null>;
  open: (
    change: WorkspaceChangeSummary,
    trigger: HTMLElement,
  ) => Promise<void>;
  close: (options?: { restore_focus?: boolean }) => void;
  retry: () => Promise<void>;
  request_revert: () => void;
  cancel_revert: () => void;
  confirm_revert: () => Promise<void>;
};

export type UseWorkspaceChangeReviewOptions = {
  active_project_id: string | null;
  active_session_id: string | null;
  read_change: (
    projectId: string,
    changeId: string,
  ) => Promise<WorkspaceChangeSnapshot>;
  revert_change: (
    projectId: string,
    changeId: string,
  ) => Promise<WorkspaceChangeRevertResult>;
};

export function useWorkspaceChangeReview({
  active_project_id: activeProjectId,
  active_session_id: activeSessionId,
  read_change: readChange,
  revert_change: revertChange,
}: UseWorkspaceChangeReviewOptions): WorkspaceChangeReviewController {
  const [view, setView] = useState<WorkspaceChangeReviewView>({
    phase: "idle",
  });
  const viewRef = useRef(view);
  const requestGenerationRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const close = useCallback(
    (options: { restore_focus?: boolean } = {}) => {
      const restoreFocus = options.restore_focus ?? true;
      const trigger = returnFocusRef.current;
      const activeElement =
        typeof document === "undefined" ? null : document.activeElement;
      const shouldRestore =
        restoreFocus &&
        trigger?.isConnected === true &&
        (activeElement === document.body ||
          (activeElement instanceof HTMLElement &&
            activeElement.closest(".workspace-panel") !== null));

      requestGenerationRef.current += 1;
      returnFocusRef.current = null;
      setView({ phase: "idle" });

      if (shouldRestore) {
        requestAnimationFrame(() => {
          if (trigger.isConnected) trigger.focus();
        });
      }
    },
    [],
  );

  useEffect(() => {
    const current = viewRef.current;
    if (current.phase === "idle") return;
    if (
      current.selection.project_id === activeProjectId &&
      current.selection.session_id === activeSessionId
    ) {
      return;
    }
    close({ restore_focus: false });
  }, [activeProjectId, activeSessionId, close]);

  const load = useCallback(
    async (
      selection: WorkspaceChangeSelection,
      generation: number,
    ): Promise<void> => {
      try {
        const snapshot = await readChange(
          selection.project_id,
          selection.change_id,
        );
        if (requestGenerationRef.current !== generation) return;
        setView({
          phase: "ready",
          selection,
          snapshot,
          is_reverting: false,
          is_confirming: false,
          action_error: null,
        });
      } catch (error) {
        if (requestGenerationRef.current !== generation) return;
        setView({
          phase: "error",
          selection,
          message: workspaceChangeErrorMessage(
            error,
            "The workspace change could not be loaded.",
          ),
        });
      }
    },
    [readChange],
  );

  const open = useCallback(
    async (
      change: WorkspaceChangeSummary,
      trigger: HTMLElement,
    ): Promise<void> => {
      if (!activeProjectId) return;
      const selection: WorkspaceChangeSelection = {
        project_id: activeProjectId,
        session_id: activeSessionId,
        change_id: change.change_id,
        summary: change,
      };
      const generation = requestGenerationRef.current + 1;
      requestGenerationRef.current = generation;
      returnFocusRef.current = trigger;
      setView({ phase: "loading", selection });
      await load(selection, generation);
    },
    [activeProjectId, activeSessionId, load],
  );

  const retry = useCallback(async (): Promise<void> => {
    const current = viewRef.current;
    if (current.phase !== "error") return;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setView({ phase: "loading", selection: current.selection });
    await load(current.selection, generation);
  }, [load]);

  const requestRevert = useCallback(() => {
    setView((current) => {
      if (
        current.phase !== "ready" ||
        current.snapshot.change.revert_status !== "available" ||
        current.is_reverting
      ) {
        return current;
      }
      return {
        ...current,
        is_confirming: true,
        action_error: null,
      };
    });
  }, []);

  const cancelRevert = useCallback(() => {
    setView((current) =>
      current.phase === "ready"
        ? { ...current, is_confirming: false }
        : current,
    );
  }, []);

  const confirmRevert = useCallback(async (): Promise<void> => {
    const current = viewRef.current;
    if (
      current.phase !== "ready" ||
      current.snapshot.change.revert_status !== "available" ||
      current.is_reverting
    ) {
      return;
    }

    const generation = requestGenerationRef.current;
    const { selection, snapshot } = current;
    setView({
      ...current,
      is_reverting: true,
      is_confirming: true,
      action_error: null,
    });

    try {
      const result = await revertChange(
        selection.project_id,
        selection.change_id,
      );
      if (requestGenerationRef.current !== generation) return;
      try {
        const refreshed = await readChange(
          selection.project_id,
          selection.change_id,
        );
        if (requestGenerationRef.current !== generation) return;
        setView({
          phase: "ready",
          selection,
          snapshot: refreshed,
          is_reverting: false,
          is_confirming: false,
          action_error: null,
        });
      } catch {
        if (requestGenerationRef.current !== generation) return;
        setView({
          phase: "ready",
          selection,
          snapshot: revertedWorkspaceChangeSnapshot(snapshot, result),
          is_reverting: false,
          is_confirming: false,
          action_error:
            "The change was reverted, but its latest file state could not be loaded.",
        });
      }
    } catch (error) {
      if (requestGenerationRef.current !== generation) return;
      const actionError = workspaceChangeErrorMessage(
        error,
        "The workspace change could not be reverted.",
      );
      try {
        const refreshed = await readChange(
          selection.project_id,
          selection.change_id,
        );
        if (requestGenerationRef.current !== generation) return;
        setView({
          phase: "ready",
          selection,
          snapshot: refreshed,
          is_reverting: false,
          is_confirming: false,
          action_error: actionError,
        });
      } catch {
        if (requestGenerationRef.current !== generation) return;
        setView({
          phase: "ready",
          selection,
          snapshot,
          is_reverting: false,
          is_confirming: false,
          action_error: actionError,
        });
      }
    }
  }, [readChange, revertChange]);

  return {
    view,
    return_focus_ref: returnFocusRef,
    open,
    close,
    retry,
    request_revert: requestRevert,
    cancel_revert: cancelRevert,
    confirm_revert: confirmRevert,
  };
}

export function revertedWorkspaceChangeSnapshot(
  snapshot: WorkspaceChangeSnapshot,
  result: WorkspaceChangeRevertResult,
): WorkspaceChangeSnapshot {
  return {
    ...snapshot,
    workspace_revision: result.workspace_revision,
    change: {
      ...snapshot.change,
      current_content:
        snapshot.change.change_kind === "created"
          ? null
          : snapshot.change.before_content,
      reverted_at_workspace_revision:
        result.reverted_at_workspace_revision,
      revert_status: "already_reverted",
    },
  };
}

function workspaceChangeErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}
