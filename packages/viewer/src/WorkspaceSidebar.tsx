"use client";

import {
  ChevronLeft,
  Folder,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  SquarePen,
} from "lucide-react";
import type { ProjectSummary, SessionSummary } from "@researchbox/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ManagementDialog,
  type ManagementDialogResult,
  type ManagementDialogState,
} from "./ManagementDialog.tsx";

export function WorkspaceSidebar({
  isOpen,
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  isPending,
  onClose,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onSelectProject,
  onSelectNewChat,
  onRenameSession,
  onDeleteSession,
  onSelectSession,
}: {
  isOpen: boolean;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  isPending: boolean;
  onClose: () => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onDeleteProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onSelectNewChat: (projectId?: string) => void;
  onRenameSession: (projectId: string, sessionId: string, title: string) => void;
  onDeleteSession: (projectId: string, sessionId: string) => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ManagementDialogState | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeSessions = useMemo(
    () => sessions.filter((session) => session.project_id === activeProjectId),
    [activeProjectId, sessions],
  );
  const activeProject = projects.find(
    (project) => project.project_id === activeProjectId,
  );

  useEffect(() => {
    if (!openMenu) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-management-menu]")) {
        return;
      }
      setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpenMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || openMenu) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, onClose, openMenu]);

  function selectProject(projectId: string) {
    setOpenMenu(null);
    onSelectProject(projectId);
    onClose();
  }

  function selectSession(projectId: string, sessionId: string) {
    setOpenMenu(null);
    onSelectSession(projectId, sessionId);
    onClose();
  }

  function selectNewChat() {
    setOpenMenu(null);
    onSelectNewChat(activeProjectId ?? undefined);
    onClose();
  }

  function submitDialog(result: ManagementDialogResult) {
    switch (result.kind) {
      case "project_create":
        onCreateProject(result.name);
        return;
      case "project_rename":
        onRenameProject(result.project_id, result.name);
        return;
      case "project_delete":
        onDeleteProject(result.project_id);
        return;
      case "session_rename":
        onRenameSession(
          result.project_id,
          result.session_id,
          result.title,
        );
        return;
      case "session_delete":
        onDeleteSession(result.project_id, result.session_id);
    }
  }

  return (
    <>
      <aside
        id="researchbox-navigation"
        className={`sidebar ${isOpen ? "sidebar-open" : ""}`}
      >
        <div className="sidebar-topline">
          <div className="brand-lockup" aria-label="ResearchBox">
            <span className="brand-mark">R</span>
            <span>ResearchBox</span>
          </div>
          <button
            ref={closeButtonRef}
            className="icon-button"
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <ChevronLeft size={18} strokeWidth={1.8} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <button
            type="button"
            aria-current={
              activeProjectId && activeSessionId === null ? "page" : undefined
            }
            disabled={!activeProjectId || isPending}
            onClick={selectNewChat}
          >
            <SquarePen size={18} />
            <span>New chat</span>
          </button>
        </nav>

        <section className="entity-section project-section" aria-labelledby="projects-label">
          <div className="section-label">
            <span id="projects-label">Projects</span>
            <button
              type="button"
              aria-label="Create project"
              disabled={isPending}
              onClick={() => setDialog({ kind: "project_create" })}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="entity-list project-list">
            {projects.map((project) => {
              const menuId = `project:${project.project_id}`;
              return (
                <div
                  className={`management-row ${project.project_id === activeProjectId ? "active" : ""}`}
                  key={project.project_id}
                  data-management-menu
                >
                  <button
                    className="entity-select"
                    type="button"
                    aria-current={project.project_id === activeProjectId ? "page" : undefined}
                    disabled={isPending}
                    onClick={() => selectProject(project.project_id)}
                  >
                    <Folder size={15} />
                    <span>{project.name}</span>
                  </button>
                  <button
                    className="entity-menu-button"
                    type="button"
                    aria-label={`Options for ${project.name}`}
                    aria-expanded={openMenu === menuId}
                    aria-controls={`${menuId}:options`}
                    disabled={isPending}
                    onClick={() => setOpenMenu(openMenu === menuId ? null : menuId)}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {openMenu === menuId && (
                    <div className="entity-menu" id={`${menuId}:options`}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          setDialog({
                            kind: "project_rename",
                            project_id: project.project_id,
                            name: project.name,
                          });
                        }}
                      >
                        Rename
                      </button>
                      <button
                        className="danger"
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          setDialog({
                            kind: "project_delete",
                            project_id: project.project_id,
                            name: project.name,
                          });
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section className="entity-section session-section" aria-labelledby="chats-label">
          <div className="section-label">
            <span id="chats-label">Chats</span>
            <button
              type="button"
              aria-label="Create chat"
              disabled={!activeProjectId || isPending}
              onClick={selectNewChat}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="entity-list session-list">
            {activeSessions.map((session) => {
              const menuId = `session:${session.session_id}`;
              return (
                <div
                  className={`management-row ${session.session_id === activeSessionId ? "active" : ""}`}
                  key={session.session_id}
                  data-management-menu
                >
                  <button
                    className="entity-select"
                    type="button"
                    aria-current={session.session_id === activeSessionId ? "page" : undefined}
                    disabled={isPending}
                    onClick={() =>
                      selectSession(session.project_id, session.session_id)
                    }
                  >
                    <MessageSquareText size={15} />
                    <span>{session.title}</span>
                  </button>
                  <button
                    className="entity-menu-button"
                    type="button"
                    aria-label={`Options for ${session.title}`}
                    aria-expanded={openMenu === menuId}
                    aria-controls={`${menuId}:options`}
                    disabled={isPending}
                    onClick={() => setOpenMenu(openMenu === menuId ? null : menuId)}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {openMenu === menuId && (
                    <div className="entity-menu" id={`${menuId}:options`}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          setDialog({
                            kind: "session_rename",
                            project_id: session.project_id,
                            session_id: session.session_id,
                            title: session.title,
                          });
                        }}
                      >
                        Rename
                      </button>
                      <button
                        className="danger"
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          setDialog({
                            kind: "session_delete",
                            project_id: session.project_id,
                            session_id: session.session_id,
                            title: session.title,
                          });
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <div className="storage-status">
          <span className="profile-avatar">{activeProject?.name.slice(0, 1).toUpperCase() ?? "R"}</span>
          <span className="profile-copy">
            <strong>{activeProject?.name ?? "Loading workspace"}</strong>
            <small>Saved on this device</small>
          </span>
        </div>
      </aside>

      <ManagementDialog
        state={dialog}
        isPending={isPending}
        onClose={() => setDialog(null)}
        onSubmit={submitDialog}
      />
    </>
  );
}
