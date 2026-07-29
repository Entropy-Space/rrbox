import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSidebarProjectNodes,
  isProjectDraftVisible,
  pruneExpandedProjects,
  reconcileExpandedProjects,
  revealExpandedProject,
  toggleExpandedProject,
} from "../src/sidebar-project-tree.ts";

test("groups sessions by project without changing input order or inputs", () => {
  const projects = Object.freeze([
    Object.freeze(project("project-2", true)),
    Object.freeze(project("project-1", false)),
    Object.freeze(project("project-3", false)),
  ]);
  const sessions = Object.freeze([
    Object.freeze(session("session-2a", "project-2")),
    Object.freeze(session("session-1a", "project-1")),
    Object.freeze(session("orphan", "missing-project")),
    Object.freeze(session("session-2b", "project-2")),
    Object.freeze(session("session-1b", "project-1")),
  ]);

  const nodes = buildSidebarProjectNodes({ projects, sessions });

  assert.deepEqual(
    nodes.map((node) => ({
      project_id: node.project.project_id,
      session_ids: node.sessions.map((candidate) => candidate.session_id),
    })),
    [
      {
        project_id: "project-2",
        session_ids: ["session-2a", "session-2b"],
      },
      {
        project_id: "project-1",
        session_ids: ["session-1a", "session-1b"],
      },
      { project_id: "project-3", session_ids: [] },
    ],
  );
  assert.equal(nodes[0].project, projects[0]);
  assert.equal(nodes[0].sessions[0], sessions[0]);
  assert.notEqual(nodes[0].sessions, sessions);
  assert.deepEqual(
    projects.map((candidate) => candidate.project_id),
    ["project-2", "project-1", "project-3"],
  );
  assert.deepEqual(
    sessions.map((candidate) => candidate.session_id),
    [
      "session-2a",
      "session-1a",
      "orphan",
      "session-2b",
      "session-1b",
    ],
  );
});

test("the active virtual chat stays visible while its input changes", () => {
  const activeProject = project("project-1", true);

  assert.equal(
    isProjectDraftVisible({
      project: activeProject,
      activeProjectId: "project-1",
      activeSessionId: null,
    }),
    true,
  );
  assert.equal(
    isProjectDraftVisible({
      project: project("project-1", false),
      activeProjectId: "project-1",
      activeSessionId: null,
    }),
    true,
  );
  assert.equal(
    isProjectDraftVisible({
      project: activeProject,
      activeProjectId: "project-1",
      activeSessionId: "session-1",
    }),
    false,
  );
});

test("inactive projects use their persisted draft summary", () => {
  for (const [hasDraft, expected] of [
    [false, false],
    [true, true],
  ]) {
    assert.equal(
      isProjectDraftVisible({
        project: project("project-2", hasDraft),
        activeProjectId: "project-1",
        activeSessionId: null,
      }),
      expected,
    );
    assert.equal(
      isProjectDraftVisible({
        project: project("project-2", hasDraft),
        activeProjectId: null,
        activeSessionId: null,
      }),
      expected,
    );
  }

  const legacyProject = project("legacy-project", false);
  delete legacyProject.has_new_chat_draft;
  assert.equal(
    isProjectDraftVisible({
      project: legacyProject,
      activeProjectId: "project-1",
      activeSessionId: null,
    }),
    false,
  );
});

test("revealing and toggling projects never mutate the current set", () => {
  const current = new Set(["project-1", "project-2"]);
  const revealed = revealExpandedProject(current, "project-3");

  assert.deepEqual([...current], ["project-1", "project-2"]);
  assert.deepEqual(
    [...revealed],
    ["project-1", "project-2", "project-3"],
  );
  assert.notEqual(revealed, current);
  assert.equal(revealExpandedProject(revealed, "project-2"), revealed);

  const collapsed = toggleExpandedProject(revealed, "project-2");
  assert.deepEqual(
    [...revealed],
    ["project-1", "project-2", "project-3"],
  );
  assert.deepEqual([...collapsed], ["project-1", "project-3"]);
  assert.notEqual(collapsed, revealed);

  const expanded = toggleExpandedProject(collapsed, "project-4");
  assert.deepEqual(
    [...expanded],
    ["project-1", "project-3", "project-4"],
  );
  assert.deepEqual([...collapsed], ["project-1", "project-3"]);
});

test("pruning removes stale IDs immutably and preserves surviving order", () => {
  const current = new Set([
    "project-3",
    "deleted-project",
    "project-1",
    "also-deleted",
  ]);
  const pruned = pruneExpandedProjects(
    current,
    new Set(["project-1", "project-2", "project-3"]),
  );

  assert.deepEqual(
    [...current],
    [
      "project-3",
      "deleted-project",
      "project-1",
      "also-deleted",
    ],
  );
  assert.deepEqual([...pruned], ["project-3", "project-1"]);
  assert.notEqual(pruned, current);

  const unchanged = new Set(["project-3", "project-1"]);
  assert.equal(
    pruneExpandedProjects(
      unchanged,
      new Set(["project-1", "project-2", "project-3"]),
    ),
    unchanged,
  );
});

test("a changed active chat reveals its project after a manual collapse", () => {
  const validProjectIds = new Set(["project-1", "project-2"]);

  assert.deepEqual(
    [
      ...reconcileExpandedProjects({
        current: new Set(),
        validProjectIds,
        activeProjectId: "project-1",
        activeSelectionChanged: true,
      }),
    ],
    ["project-1"],
  );
  assert.deepEqual(
    [
      ...reconcileExpandedProjects({
        current: new Set(),
        validProjectIds,
        activeProjectId: "project-1",
        activeSelectionChanged: false,
      }),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...reconcileExpandedProjects({
        current: new Set(["deleted-project"]),
        validProjectIds,
        activeProjectId: "deleted-project",
        activeSelectionChanged: true,
      }),
    ],
    [],
  );
});

function project(projectId, hasNewChatDraft) {
  return {
    project_id: projectId,
    name: projectId,
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T00:00:00.000Z",
    has_new_chat_draft: hasNewChatDraft,
  };
}

function session(sessionId, projectId) {
  return {
    session_id: sessionId,
    project_id: projectId,
    title: sessionId,
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T00:00:00.000Z",
    message_count: 1,
  };
}
