"use client";

import {
  ChevronRight,
  ChevronLeft,
  Folder,
  FolderOpen,
  MessageSquareText,
  MoreHorizontal,
  Puzzle,
  ServerCog,
  Plus,
  Search,
  SquarePen,
  Upload,
} from "lucide-react";
import type { ProjectSummary, SessionSummary } from "@researchbox/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ManagementDialog,
  type ManagementDialogResult,
  type ManagementDialogState,
} from "./ManagementDialog.tsx";
import { navigationFocusTrapTarget } from "./navigation-state.ts";
import {
  buildSidebarProjectNodes,
  isProjectDraftVisible,
  reconcileExpandedProjects,
  toggleExpandedProject,
} from "./sidebar-project-tree.ts";
import type { WorkspaceTransferNotice } from "./workspace-transfer.ts";

export function WorkspaceSidebar({
  isOpen,
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  isPending,
  isWorkspaceTransferDisabled,
  onClose,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onSelectProject,
  onImportProject,
  onExportProject,
  workspaceTransferNotice,
  onCancelWorkspaceTransfer,
  onSelectNewChat,
  onOpenChatSearch,
  onOpenPlugins,
  isPluginsActive = false,
  onOpenProviders,
  isProvidersActive = false,
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
  isWorkspaceTransferDisabled: boolean;
  onClose: () => void;
  onCreateProject: (name: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onDeleteProject: (projectId: string) => void;
  onSelectProject: (projectId: string) => void;
  onImportProject?: () => void | Promise<void>;
  onExportProject?: (projectId: string) => void | Promise<void>;
  workspaceTransferNotice: WorkspaceTransferNotice | null;
  onCancelWorkspaceTransfer?: () => void;
  onSelectNewChat: (projectId?: string) => void;
  onOpenChatSearch: () => void;
  onOpenPlugins?: () => void;
  isPluginsActive?: boolean;
  onOpenProviders?: () => void;
  isProvidersActive?: boolean;
  onRenameSession: (projectId: string, sessionId: string, title: string) => void;
  onDeleteSession: (projectId: string, sessionId: string) => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ManagementDialogState | null>(null);
  const [projectExpansion, setProjectExpansion] =
    useState<ProjectExpansionState>(() => ({
      activeProjectId,
      activeSessionId,
      projectIdsSignature: projectIdSignature(projects),
      expandedProjectIds:
        activeProjectId === null
          ? new Set()
          : new Set([activeProjectId]),
    }));
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const menuButtonRefs = useRef(
    new Map<string, HTMLButtonElement>(),
  );
  const workspaceTransferStatusRef = useRef<HTMLDivElement | null>(null);
  const workspaceTransferReturnFocusRef =
    useRef<WorkspaceTransferFocusRequest | null>(null);
  const scheduleWorkspaceTransferFocusRestore = useCallback(
    (focusRequest: WorkspaceTransferFocusRequest) => {
      window.requestAnimationFrame(() => {
        if (workspaceTransferReturnFocusRef.current !== focusRequest) return;
        const { target } = focusRequest;
        if (!target.isConnected) {
          workspaceTransferReturnFocusRef.current = null;
          return;
        }
        if (isDisabledButton(target)) return;

        workspaceTransferReturnFocusRef.current = null;
        const activeElement = document.activeElement;
        if (
          activeElement !== null &&
          activeElement !== document.body &&
          activeElement !== workspaceTransferStatusRef.current &&
          activeElement !== target
        ) {
          return;
        }
        target.focus({ preventScroll: true });
      });
    },
    [],
  );
  const projectNodes = useMemo(
    () => buildSidebarProjectNodes({ projects, sessions }),
    [projects, sessions],
  );
  const activeProject = projects.find(
    (project) => project.project_id === activeProjectId,
  );
  const projectIds = useMemo(
    () => new Set(projects.map((project) => project.project_id)),
    [projects],
  );
  const sessionIds = useMemo(
    () => new Set(sessions.map((session) => session.session_id)),
    [sessions],
  );
  const currentProjectIdsSignature = projectIdSignature(projects);
  let resolvedExpansion = projectExpansion;
  if (
    projectExpansion.activeProjectId !== activeProjectId ||
    projectExpansion.activeSessionId !== activeSessionId ||
    projectExpansion.projectIdsSignature !== currentProjectIdsSignature
  ) {
    const activeSelectionChanged =
      projectExpansion.activeProjectId !== activeProjectId ||
      projectExpansion.activeSessionId !== activeSessionId;
    const expandedProjectIds = reconcileExpandedProjects({
      current: projectExpansion.expandedProjectIds,
      validProjectIds: projectIds,
      activeProjectId,
      activeSelectionChanged,
    });
    resolvedExpansion = {
      activeProjectId,
      activeSessionId,
      projectIdsSignature: currentProjectIdsSignature,
      expandedProjectIds,
    };
    setProjectExpansion(resolvedExpansion);
  }
  const expandedProjectIds = resolvedExpansion.expandedProjectIds;
  const resolvedOpenMenu =
    openMenu &&
    isExistingMenuTarget(openMenu, projectIds, sessionIds)
      ? openMenu
      : null;
  const resolvedDialog =
    dialog && isExistingDialogTarget(dialog, projectIds, sessionIds)
      ? dialog
      : null;

  useEffect(() => {
    if (!resolvedOpenMenu) return;
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
        const menuButton = menuButtonRefs.current.get(resolvedOpenMenu);
        setOpenMenu(null);
        window.requestAnimationFrame(() =>
          menuButton?.focus({ preventScroll: true }),
        );
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [resolvedOpenMenu]);

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
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || document.querySelector("dialog[open]")) {
        return;
      }
      const sidebar = sidebarRef.current;
      if (!sidebar) return;
      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      const activeElement = document.activeElement;
      const focusTarget = navigationFocusTrapTarget({
        isFocusInside: sidebar.contains(activeElement),
        isFocusFirst: activeElement === first,
        isFocusLast: activeElement === last,
        shiftKey: event.shiftKey,
      });
      if (focusTarget) {
        event.preventDefault();
        (focusTarget === "first" ? first : last).focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        resolvedOpenMenu
      ) {
        return;
      }
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, onClose, resolvedOpenMenu]);

  useEffect(() => {
    if (workspaceTransferNotice?.kind !== "progress") return;
    const activeElement = document.activeElement;
    const returnFocusTarget =
      workspaceTransferReturnFocusRef.current?.target ?? null;
    if (
      activeElement !== null &&
      activeElement !== document.body &&
      activeElement !== workspaceTransferStatusRef.current &&
      activeElement !== returnFocusTarget
    ) {
      return;
    }
    workspaceTransferStatusRef.current?.focus({ preventScroll: true });
  }, [workspaceTransferNotice?.kind, workspaceTransferNotice?.message]);

  useEffect(() => {
    if (workspaceTransferNotice?.kind === "progress") return;
    const focusRequest = workspaceTransferReturnFocusRef.current;
    if (focusRequest) scheduleWorkspaceTransferFocusRestore(focusRequest);
  }, [
    scheduleWorkspaceTransferFocusRestore,
    workspaceTransferNotice?.kind,
  ]);

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

  function selectNewChat(projectId?: string) {
    setOpenMenu(null);
    onSelectNewChat(projectId ?? activeProjectId ?? undefined);
    onClose();
  }

  function toggleProject(projectId: string) {
    setOpenMenu(null);
    setProjectExpansion((current) => ({
      ...current,
      expandedProjectIds: toggleExpandedProject(
        current.expandedProjectIds,
        projectId,
      ),
    }));
  }

  function registerMenuButton(
    menuId: string,
    button: HTMLButtonElement | null,
  ) {
    if (button) {
      menuButtonRefs.current.set(menuId, button);
    } else {
      menuButtonRefs.current.delete(menuId);
    }
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

  function startWorkspaceTransfer(
    returnFocusTarget: HTMLElement,
    operation: () => void | Promise<void>,
  ) {
    const focusRequest = { target: returnFocusTarget };
    workspaceTransferReturnFocusRef.current = focusRequest;
    let completion: void | Promise<void>;
    try {
      completion = operation();
    } catch (error) {
      scheduleWorkspaceTransferFocusRestore(focusRequest);
      throw error;
    }
    void Promise.resolve(completion).then(
      () => scheduleWorkspaceTransferFocusRestore(focusRequest),
      () => scheduleWorkspaceTransferFocusRestore(focusRequest),
    );
  }

  function cancelWorkspaceTransfer() {
    const focusRequest = workspaceTransferReturnFocusRef.current;
    onCancelWorkspaceTransfer?.();
    if (focusRequest) scheduleWorkspaceTransferFocusRestore(focusRequest);
  }

  return (
    <>
      <aside
        ref={sidebarRef}
        id="researchbox-navigation"
        className={`sidebar ${isOpen ? "sidebar-open" : ""}`}
        role={isOpen ? "dialog" : undefined}
        aria-modal={isOpen ? true : undefined}
        aria-label="Workspace navigation"
      >
        <div className="sidebar-topline">
          <div className="brand-lockup" aria-label="rrbox">
            <span className="brand-mark">rr</span>
            <span>rrbox</span>
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
            disabled={!activeProjectId || isPending}
            onClick={() => selectNewChat()}
          >
            <SquarePen size={18} />
            <span>New chat</span>
          </button>
          <button
            type="button"
            title="Search chats (Ctrl or Command + K)"
            aria-keyshortcuts="Control+K Meta+K"
            disabled={isPending}
            onClick={() => {
              setOpenMenu(null);
              onOpenChatSearch();
            }}
          >
            <Search size={18} />
            <span>Search chats</span>
            <kbd aria-hidden={true}>⌘ K</kbd>
          </button>
          {onOpenPlugins && (
            <button
              className={isPluginsActive ? "active" : undefined}
              type="button"
              aria-current={isPluginsActive ? "page" : undefined}
              disabled={isPending}
              onClick={() => {
                setOpenMenu(null);
                onOpenPlugins();
              }}
            >
              <Puzzle size={18} />
              <span>Plugins</span>
            </button>
          )}
          {onOpenProviders && (
            <button
              className={isProvidersActive ? "active" : undefined}
              type="button"
              aria-current={isProvidersActive ? "page" : undefined}
              onClick={() => {
                setOpenMenu(null);
                onOpenProviders();
              }}
            >
              <ServerCog size={18} />
              <span>Providers</span>
            </button>
          )}
        </nav>

        <section
          className="entity-section project-section"
          aria-labelledby="projects-label"
        >
          <div className="section-label">
            <span id="projects-label">Projects</span>
            <span className="section-actions">
              {onImportProject && (
                <button
                  type="button"
                  aria-label="Import workspace"
                  title="Import workspace"
                  disabled={isWorkspaceTransferDisabled}
                  onClick={(event) =>
                    startWorkspaceTransfer(
                      event.currentTarget,
                      onImportProject,
                    )
                  }
                >
                  <Upload size={15} />
                </button>
              )}
              <button
                type="button"
                aria-label="Create project"
                disabled={isPending}
                onClick={() => setDialog({ kind: "project_create" })}
              >
                <Plus size={16} />
              </button>
            </span>
          </div>
          <div className="project-tree-scroll">
            <div className="project-tree">
              {projectNodes.map(({ project, sessions: projectSessions }) => {
                const menuId = `project:${project.project_id}`;
                const chatsId = `project-chats-${project.project_id}`;
                const isExpanded = expandedProjectIds.has(
                  project.project_id,
                );
                const isActive =
                  project.project_id === activeProjectId;
                const showDraft = isProjectDraftVisible({
                  project,
                  activeProjectId,
                  activeSessionId,
                });
                return (
                  <div
                    className={`project-node ${isActive ? "active" : ""}`}
                    key={project.project_id}
                  >
                    <div
                      className="management-row project-row"
                      data-management-menu
                    >
                      <button
                        className="project-disclosure"
                        type="button"
                        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${project.name}`}
                        aria-expanded={isExpanded}
                        aria-controls={chatsId}
                        onClick={() => toggleProject(project.project_id)}
                      >
                        <ChevronRight size={14} strokeWidth={2} />
                      </button>
                      <button
                        className="entity-select project-select"
                        type="button"
                        disabled={isPending}
                        title={project.name}
                        onClick={() => selectProject(project.project_id)}
                      >
                        {isExpanded ? (
                          <FolderOpen size={15} />
                        ) : (
                          <Folder size={15} />
                        )}
                        <span className="entity-label">{project.name}</span>
                      </button>
                      <button
                        className="project-chat-button"
                        type="button"
                        aria-label={`New chat in ${project.name}`}
                        title={`New chat in ${project.name}`}
                        disabled={isPending}
                        onClick={() => selectNewChat(project.project_id)}
                      >
                        <SquarePen size={14} />
                      </button>
                      <button
                        ref={(button) =>
                          registerMenuButton(menuId, button)
                        }
                        className="entity-menu-button"
                        type="button"
                        aria-label={`Options for ${project.name}`}
                        aria-expanded={resolvedOpenMenu === menuId}
                        aria-controls={`${menuId}:options`}
                        disabled={isPending}
                        onClick={() =>
                          setOpenMenu(
                            resolvedOpenMenu === menuId ? null : menuId,
                          )
                        }
                      >
                        <MoreHorizontal size={16} />
                      </button>
                    </div>

                    {resolvedOpenMenu === menuId && (
                      <div
                        className="entity-menu"
                        id={`${menuId}:options`}
                        aria-label={`Project actions for ${project.name}`}
                        data-management-menu
                      >
                        {onExportProject && (
                          <button
                            type="button"
                            disabled={isWorkspaceTransferDisabled}
                            onClick={(event) => {
                              const returnFocusTarget =
                                menuButtonRefs.current.get(menuId) ??
                                event.currentTarget;
                              setOpenMenu(null);
                              startWorkspaceTransfer(
                                returnFocusTarget,
                                () => onExportProject(project.project_id),
                              );
                            }}
                          >
                            Export workspace
                          </button>
                        )}
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

                    {isExpanded && (
                      <div
                        className="project-children"
                        id={chatsId}
                        role="group"
                        aria-label={`Chats in ${project.name}`}
                      >
                        {showDraft && (
                          <div
                            className={`management-row nested-row ${
                              isActive && activeSessionId === null
                                ? "active"
                                : ""
                            }`}
                          >
                            <button
                              className="entity-select nested-select"
                              type="button"
                              aria-current={
                                isActive && activeSessionId === null
                                  ? "page"
                                  : undefined
                              }
                              disabled={isPending}
                              onClick={() =>
                                selectNewChat(project.project_id)
                              }
                            >
                              <SquarePen size={14} />
                              <span className="entity-label">New chat</span>
                              <span className="entity-meta">Draft</span>
                            </button>
                          </div>
                        )}

                        {projectSessions.map((session) => {
                          const sessionMenuId =
                            `session:${session.session_id}`;
                          const sessionActive =
                            isActive &&
                            session.session_id === activeSessionId;
                          return (
                            <div
                              className={`management-row nested-row ${sessionActive ? "active" : ""}`}
                              key={session.session_id}
                              data-management-menu
                            >
                              <button
                                className="entity-select nested-select"
                                type="button"
                                aria-current={
                                  sessionActive ? "page" : undefined
                                }
                                aria-label={`${session.title}, ${project.name}`}
                                title={session.title}
                                disabled={isPending}
                                onClick={() =>
                                  selectSession(
                                    session.project_id,
                                    session.session_id,
                                  )
                                }
                              >
                                <MessageSquareText size={14} />
                                <span className="entity-label">
                                  {session.title}
                                </span>
                              </button>
                              <button
                                ref={(button) =>
                                  registerMenuButton(
                                    sessionMenuId,
                                    button,
                                  )
                                }
                                className="entity-menu-button"
                                type="button"
                                aria-label={`Options for ${session.title}`}
                                aria-expanded={
                                  resolvedOpenMenu === sessionMenuId
                                }
                                aria-controls={`${sessionMenuId}:options`}
                                disabled={isPending}
                                onClick={() =>
                                  setOpenMenu(
                                    resolvedOpenMenu === sessionMenuId
                                      ? null
                                      : sessionMenuId,
                                  )
                                }
                              >
                                <MoreHorizontal size={16} />
                              </button>
                              {resolvedOpenMenu === sessionMenuId && (
                                <div
                                  className="entity-menu nested-menu"
                                  id={`${sessionMenuId}:options`}
                                  aria-label={`Chat actions for ${session.title}`}
                                  data-management-menu
                                >
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

                        {!showDraft && projectSessions.length === 0 && (
                          <button
                            className="project-empty-action"
                            type="button"
                            disabled={isPending}
                            onClick={() =>
                              selectNewChat(project.project_id)
                            }
                          >
                            <Plus size={13} />
                            <span>Start a chat</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {workspaceTransferNotice && (
          <div
            ref={workspaceTransferStatusRef}
            className={`status-banner ${workspaceTransferNotice.kind === "error" ? "failed" : ""}`}
            role={
              workspaceTransferNotice.kind === "error" ? "alert" : "status"
            }
            aria-atomic={true}
            aria-busy={
              workspaceTransferNotice.kind === "progress" ? true : undefined
            }
            tabIndex={-1}
          >
            <span>{workspaceTransferNotice.message}</span>
            {workspaceTransferNotice.kind === "progress" &&
              workspaceTransferNotice.is_cancellable &&
              onCancelWorkspaceTransfer && (
                <button
                  type="button"
                  className="status-banner-action"
                  onClick={cancelWorkspaceTransfer}
                >
                  Cancel
                </button>
              )}
          </div>
        )}

        <div className="storage-status">
          <span className="profile-avatar">{activeProject?.name.slice(0, 1).toUpperCase() ?? "R"}</span>
          <span className="profile-copy">
            <strong>{activeProject?.name ?? "Loading workspace"}</strong>
            <small>Saved on this device</small>
          </span>
        </div>
      </aside>

      <ManagementDialog
        state={resolvedDialog}
        isPending={isPending}
        onClose={() => setDialog(null)}
        onSubmit={submitDialog}
      />
    </>
  );
}

type ProjectExpansionState = {
  activeProjectId: string | null;
  activeSessionId: string | null;
  projectIdsSignature: string;
  expandedProjectIds: ReadonlySet<string>;
};

type WorkspaceTransferFocusRequest = {
  target: HTMLElement;
};

function projectIdSignature(projects: readonly ProjectSummary[]): string {
  return JSON.stringify(
    projects.map((project) => project.project_id),
  );
}

function isDisabledButton(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement && element.disabled;
}

function isExistingMenuTarget(
  menuId: string,
  projectIds: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>,
): boolean {
  if (menuId.startsWith("project:")) {
    return projectIds.has(menuId.slice("project:".length));
  }
  if (menuId.startsWith("session:")) {
    return sessionIds.has(menuId.slice("session:".length));
  }
  return false;
}

function isExistingDialogTarget(
  dialog: ManagementDialogState,
  projectIds: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>,
): boolean {
  if (dialog.kind === "project_create") return true;
  if (
    dialog.kind === "project_rename" ||
    dialog.kind === "project_delete"
  ) {
    return projectIds.has(dialog.project_id);
  }
  return (
    projectIds.has(dialog.project_id) &&
    sessionIds.has(dialog.session_id)
  );
}
