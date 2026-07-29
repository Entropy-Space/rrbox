import type {
  ProjectSummary,
  SessionSummary,
} from "@researchbox/protocol";

export type SidebarProjectNode = {
  project: ProjectSummary;
  sessions: SessionSummary[];
};

export type BuildSidebarProjectNodesOptions = {
  projects: readonly ProjectSummary[];
  sessions: readonly SessionSummary[];
};

export type ProjectDraftVisibilityOptions = {
  project: ProjectSummary;
  activeProjectId: string | null;
  activeSessionId: string | null;
};

export function buildSidebarProjectNodes(
  options: BuildSidebarProjectNodesOptions,
): SidebarProjectNode[] {
  const sessionsByProject = new Map<string, SessionSummary[]>();
  for (const project of options.projects) {
    sessionsByProject.set(project.project_id, []);
  }
  for (const session of options.sessions) {
    sessionsByProject.get(session.project_id)?.push(session);
  }

  return options.projects.map((project) => ({
    project,
    sessions: [...(sessionsByProject.get(project.project_id) ?? [])],
  }));
}

export function isProjectDraftVisible(
  options: ProjectDraftVisibilityOptions,
): boolean {
  if (options.project.project_id !== options.activeProjectId) {
    return options.project.has_new_chat_draft === true;
  }
  return options.activeSessionId === null;
}

export function revealExpandedProject(
  current: ReadonlySet<string>,
  projectId: string,
): ReadonlySet<string> {
  if (current.has(projectId)) return current;
  const expanded = new Set(current);
  expanded.add(projectId);
  return expanded;
}

export function toggleExpandedProject(
  current: ReadonlySet<string>,
  projectId: string,
): ReadonlySet<string> {
  const expanded = new Set(current);
  if (expanded.has(projectId)) {
    expanded.delete(projectId);
  } else {
    expanded.add(projectId);
  }
  return expanded;
}

export function pruneExpandedProjects(
  current: ReadonlySet<string>,
  validProjectIds: ReadonlySet<string>,
): ReadonlySet<string> {
  let pruned: Set<string> | null = null;
  for (const projectId of current) {
    if (validProjectIds.has(projectId)) continue;
    pruned ??= new Set(current);
    pruned.delete(projectId);
  }
  return pruned ?? current;
}

export function reconcileExpandedProjects({
  current,
  validProjectIds,
  activeProjectId,
  activeSelectionChanged,
}: {
  current: ReadonlySet<string>;
  validProjectIds: ReadonlySet<string>;
  activeProjectId: string | null;
  activeSelectionChanged: boolean;
}): ReadonlySet<string> {
  const pruned = pruneExpandedProjects(current, validProjectIds);
  if (
    !activeSelectionChanged ||
    activeProjectId === null ||
    !validProjectIds.has(activeProjectId)
  ) {
    return pruned;
  }
  return revealExpandedProject(pruned, activeProjectId);
}
