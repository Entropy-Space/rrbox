export type WorkspaceChangeRevertStatus =
  | "available"
  | "already_reverted"
  | "conflict";

export type WorkspaceChangeReviewData = {
  path: string;
  change_kind: "created" | "updated";
  before_content: string | null;
  after_content: string;
  current_content: string | null;
  revert_status: WorkspaceChangeRevertStatus;
};

export type WorkspaceChangeReviewState = {
  statusMessage: string | null;
  statusRole: "alert" | "status" | null;
  revertButtonLabel: string;
  isRevertDisabled: boolean;
};

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
          : "status",
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
  if (change.revert_status !== "conflict") return null;
  return change.current_content === null
    ? "The file no longer exists, so this change cannot be reverted safely."
    : "The file changed after this agent edit. Resolve the conflict before reverting it.";
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
