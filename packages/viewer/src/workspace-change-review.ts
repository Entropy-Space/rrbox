export type WorkspaceChangeRevertStatus =
  | "available"
  | "already_reverted"
  | "conflict";

export type WorkspaceChangeReviewData = {
  path: string;
  change_kind: "created" | "updated" | "deleted";
  before_content: string | null;
  after_content: string | null;
  current_content: string | null;
  revert_status: WorkspaceChangeRevertStatus;
};

export type WorkspaceChangeReviewState = {
  statusMessage: string | null;
  statusRole: "alert" | "note" | "status" | null;
  revertButtonLabel: string;
  isRevertDisabled: boolean;
};

export type WorkspaceChangeRevertGuards = {
  is_core_ready: boolean;
  is_management_pending: boolean;
  is_running: boolean;
  has_pending_prompt: boolean;
  is_workspace_transfer_pending: boolean;
};

export function workspaceChangeRevertGuardReason(
  guards: WorkspaceChangeRevertGuards,
): string | null {
  if (!guards.is_core_ready) {
    return "Revert is unavailable until the browser core is ready.";
  }
  if (guards.is_management_pending) {
    return "Wait for the current project or chat change to finish before reverting.";
  }
  if (guards.is_running || guards.has_pending_prompt) {
    return "Wait for the current response to finish before reverting.";
  }
  if (guards.is_workspace_transfer_pending) {
    return "Wait for the workspace transfer to finish before reverting.";
  }
  return null;
}

export function createWorkspaceChangeReviewState(
  change: WorkspaceChangeReviewData,
  options: {
    isReverting?: boolean;
    isRevertDisabled?: boolean;
  } = {},
): WorkspaceChangeReviewState {
  const isReverting = options.isReverting ?? false;
  const statusMessage = workspaceChangeStatusCopy(change);
  return {
    statusMessage,
    statusRole:
      statusMessage === null
        ? null
        : change.revert_status === "conflict"
          ? "alert"
          : change.revert_status === "already_reverted"
            ? "status"
            : "note",
    revertButtonLabel: revertButtonLabel(
      change.revert_status,
      isReverting,
    ),
    isRevertDisabled:
      isReverting ||
      (options.isRevertDisabled ?? false) ||
      change.revert_status !== "available",
  };
}

function workspaceChangeStatusCopy(
  change: WorkspaceChangeReviewData,
): string | null {
  if (change.revert_status === "already_reverted") {
    return "This workspace change has already been reverted.";
  }
  if (change.revert_status !== "conflict") {
    return change.change_kind === "deleted"
      ? "Reverting this change recreates the deleted file with its exact previous content."
      : null;
  }
  if (change.change_kind === "deleted") {
    return change.current_content === null
      ? "The workspace changed after this deletion, so the file cannot be recreated safely."
      : "A file now exists at this path, so the deleted file cannot be recreated safely.";
  }
  return change.current_content === null
    ? "The file no longer exists, so this change cannot be reverted safely."
    : "The file changed after this agent edit. Resolve the conflict before reverting it.";
}

export function workspaceChangeRevertConfirmation(
  changeKind: WorkspaceChangeReviewData["change_kind"],
): string {
  if (changeKind === "created") {
    return "This removes the file only if it is still the exact agent-created version.";
  }
  if (changeKind === "deleted") {
    return "This recreates the file with its exact previous content only if the deleted path is still unchanged.";
  }
  return "This restores the exact previous content only if the file is still this agent-edited version.";
}

function revertButtonLabel(
  status: WorkspaceChangeRevertStatus,
  isReverting: boolean,
): string {
  if (isReverting) return "Reverting…";
  if (status === "already_reverted") return "Reverted";
  if (status === "conflict") return "Revert unavailable";
  return "Revert change";
}
