"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

export type ManagementDialogState =
  | { kind: "project_create" }
  | { kind: "project_rename"; project_id: string; name: string }
  | { kind: "project_delete"; project_id: string; name: string }
  | {
      kind: "session_rename";
      project_id: string;
      session_id: string;
      title: string;
    }
  | {
      kind: "session_delete";
      project_id: string;
      session_id: string;
      title: string;
    };

export type ManagementDialogResult =
  | { kind: "project_create"; name: string }
  | { kind: "project_rename"; project_id: string; name: string }
  | { kind: "project_delete"; project_id: string }
  | {
      kind: "session_rename";
      project_id: string;
      session_id: string;
      title: string;
    }
  | {
      kind: "session_delete";
      project_id: string;
      session_id: string;
    };

export function ManagementDialog({
  state,
  isPending,
  onClose,
  onSubmit,
}: {
  state: ManagementDialogState | null;
  isPending: boolean;
  onClose: () => void;
  onSubmit: (result: ManagementDialogResult) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [name, setName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !state) return;
    const initialName =
      state.kind === "project_rename"
        ? state.name
        : state.kind === "session_rename"
          ? state.title
          : "";
    setName(initialName);
    setValidationError(null);
    if (!dialog.open) dialog.showModal();
  }, [state]);

  if (!state) return null;
  const dialogState = state;
  const isDelete = dialogState.kind.endsWith("_delete");
  const copy = getDialogCopy(dialogState);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      dialogState.kind === "project_delete" ||
      dialogState.kind === "session_delete"
    ) {
      onSubmit(toDeleteResult(dialogState));
      onClose();
      return;
    }
    const normalizedName = name.trim();
    const maximum = dialogState.kind.startsWith("project") ? 80 : 100;
    if (!normalizedName || normalizedName.length > maximum) {
      setValidationError(`Enter between 1 and ${maximum} characters.`);
      return;
    }
    onSubmit(toNameResult(dialogState, normalizedName));
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="management-dialog"
      aria-labelledby="management-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!isPending) onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget && !isPending) onClose();
      }}
    >
      <form onSubmit={handleSubmit}>
        <div className="dialog-copy">
          <h2 id="management-dialog-title">{copy.title}</h2>
          <p>{copy.description}</p>
        </div>

        {!isDelete && (
          <label className="dialog-field">
            <span>{dialogState.kind.startsWith("project") ? "Project name" : "Chat title"}</span>
            <input
              autoFocus
              value={name}
              maxLength={dialogState.kind.startsWith("project") ? 80 : 100}
              aria-invalid={validationError !== null}
              aria-describedby={validationError ? "dialog-field-error" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setValidationError(null);
              }}
            />
            {validationError && (
              <small id="dialog-field-error">{validationError}</small>
            )}
          </label>
        )}

        <div className="dialog-actions">
          <button type="button" disabled={isPending} onClick={onClose}>
            Cancel
          </button>
          <button
            className={isDelete ? "danger" : "primary"}
            type="submit"
            disabled={isPending}
          >
            {isDelete ? "Delete" : dialogState.kind.endsWith("_create") ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function getDialogCopy(state: ManagementDialogState): {
  title: string;
  description: string;
} {
  switch (state.kind) {
    case "project_create":
      return {
        title: "Create a project",
        description: "Projects keep a workspace and its chats together.",
      };
    case "project_rename":
      return {
        title: "Rename project",
        description: `Choose a new name for “${state.name}”.`,
      };
    case "project_delete":
      return {
        title: "Delete project?",
        description: `“${state.name}” and all of its chats and workspace files will be permanently deleted.`,
      };
    case "session_rename":
      return {
        title: "Rename chat",
        description: `Choose a new title for “${state.title}”.`,
      };
    case "session_delete":
      return {
        title: "Delete chat?",
        description: `“${state.title}” and its message history will be permanently deleted.`,
      };
  }
}

function toDeleteResult(
  state: Extract<
    ManagementDialogState,
    { kind: "project_delete" | "session_delete" }
  >,
): ManagementDialogResult {
  return state.kind === "project_delete"
    ? { kind: "project_delete", project_id: state.project_id }
    : {
        kind: "session_delete",
        project_id: state.project_id,
        session_id: state.session_id,
      };
}

function toNameResult(
  state: Exclude<
    ManagementDialogState,
    { kind: "project_delete" | "session_delete" }
  >,
  name: string,
): ManagementDialogResult {
  switch (state.kind) {
    case "project_create":
      return { kind: "project_create", name };
    case "project_rename":
      return { kind: "project_rename", project_id: state.project_id, name };
    case "session_rename":
      return {
        kind: "session_rename",
        project_id: state.project_id,
        session_id: state.session_id,
        title: name,
      };
  }
}
