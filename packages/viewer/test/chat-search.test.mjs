import assert from "node:assert/strict";
import test from "node:test";
import {
  moveChatSearchSelection,
  searchChats,
  shouldFocusComposerAfterChatSearch,
} from "../src/chat-search.ts";

test("an empty query returns known-project chats by recency with stable ties", () => {
  const projects = [
    project("project-b", "Beta"),
    project("project-a", "Alpha"),
  ];
  const sessions = [
    session("session-b", "project-a", "Second", "2026-07-25T12:00:00.000Z"),
    session("session-z", "project-b", "Third", "2026-07-25T12:00:00.000Z"),
    session("session-old", "project-a", "Old", "2026-07-24T12:00:00.000Z"),
    session("session-a", "project-a", "First", "2026-07-25T12:00:00.000Z"),
    session("session-new", "missing-project", "Unknown", "2026-07-26T12:00:00.000Z"),
  ];

  const expected = [
    "project-a/session-a",
    "project-a/session-b",
    "project-b/session-z",
    "project-a/session-old",
  ];
  assert.deepEqual(searchResultIds(searchChats(projects, sessions, "")), expected);
  assert.deepEqual(
    searchResultIds(searchChats([...projects].reverse(), [...sessions].reverse(), " \n ")),
    expected,
  );
});

test("search normalizes case and internal whitespace in every field", () => {
  const projects = [
    project("project-a", "Research \n\t Box"),
    project("project-b", "Other"),
  ];
  const sessions = [
    session(
      "session-title",
      "project-b",
      "Build   Search\tIndex",
      "2026-07-25T12:00:00.000Z",
    ),
    session(
      "session-project",
      "project-a",
      "Unrelated chat",
      "2026-07-24T12:00:00.000Z",
    ),
  ];

  assert.deepEqual(
    searchResultIds(searchChats(projects, sessions, "  BUILD search INDEX ")),
    ["project-b/session-title"],
  );
  assert.deepEqual(
    searchResultIds(searchChats(projects, sessions, "research box")),
    ["project-a/session-project"],
  );
});

test("search ranks exact, prefix, substring, and cross-field matches", () => {
  const projects = [
    project("project-title-exact", "Other"),
    project("project-project-exact", "Needle"),
    project("project-title-prefix", "Other"),
    project("project-project-prefix", "Needle archive"),
    project("project-title-substring", "Other"),
    project("project-project-substring", "Find needle here"),
    project("project-cross-field", "Project archive"),
  ];
  const sessions = [
    session("session-cross", "project-cross-field", "Workspace", recent()),
    session("session-project-substring", "project-project-substring", "Other", recent()),
    session("session-title-substring", "project-title-substring", "Find needle here", recent()),
    session("session-project-prefix", "project-project-prefix", "Other", recent()),
    session("session-title-prefix", "project-title-prefix", "Needle notes", recent()),
    session("session-project-exact", "project-project-exact", "Other", recent()),
    session("session-title-exact", "project-title-exact", "Needle", recent()),
  ];

  assert.deepEqual(
    searchResultIds(searchChats(projects, sessions, "needle")),
    [
      "project-title-exact/session-title-exact",
      "project-project-exact/session-project-exact",
      "project-title-prefix/session-title-prefix",
      "project-project-prefix/session-project-prefix",
      "project-title-substring/session-title-substring",
      "project-project-substring/session-project-substring",
    ],
  );

  assert.deepEqual(
    searchResultIds(searchChats(projects, sessions, "workspace project")),
    ["project-cross-field/session-cross"],
  );
});

test("results include owned project and session copies without extra filtering", () => {
  const includedProject = project("project-a", "Alpha");
  const includedSession = session(
    "session-a",
    "project-a",
    "",
    "2026-07-25T12:00:00.000Z",
    0,
  );
  const missingProjectSession = session(
    "session-missing",
    "missing-project",
    "Visible title",
    "2026-07-26T12:00:00.000Z",
  );
  const projects = Object.freeze([Object.freeze(includedProject)]);
  const sessions = Object.freeze([
    Object.freeze(includedSession),
    Object.freeze(missingProjectSession),
  ]);

  const results = searchChats(projects, sessions, "");

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    project: includedProject,
    session: includedSession,
  });
  assert.notEqual(results[0].project, includedProject);
  assert.notEqual(results[0].session, includedSession);

  results[0].project.name = "Changed result";
  results[0].session.title = "Changed result";
  assert.equal(includedProject.name, "Alpha");
  assert.equal(includedSession.title, "");
});

test("keyboard selection wraps and recovers from an unavailable result", () => {
  assert.equal(moveChatSearchSelection(0, 3, "next"), 1);
  assert.equal(moveChatSearchSelection(2, 3, "next"), 0);
  assert.equal(moveChatSearchSelection(0, 3, "previous"), 2);
  assert.equal(moveChatSearchSelection(9, 3, "next"), 0);
  assert.equal(moveChatSearchSelection(9, 3, "previous"), 2);
  assert.equal(moveChatSearchSelection(0, 0, "next"), -1);
});

test("composer focus waits for search close and session selection to settle", () => {
  assert.equal(
    shouldFocusComposerAfterChatSearch(true, false, false, true),
    true,
  );
  assert.equal(
    shouldFocusComposerAfterChatSearch(true, true, false, true),
    false,
  );
  assert.equal(
    shouldFocusComposerAfterChatSearch(true, false, true, true),
    false,
  );
  assert.equal(
    shouldFocusComposerAfterChatSearch(true, false, false, false),
    false,
  );
  assert.equal(
    shouldFocusComposerAfterChatSearch(false, false, false, true),
    false,
  );
});

function searchResultIds(results) {
  return results.map(
    ({ project, session: chat }) =>
      `${project.project_id}/${chat.session_id}`,
  );
}

function recent() {
  return "2026-07-25T12:00:00.000Z";
}

function project(projectId, name) {
  return {
    project_id: projectId,
    name,
    created_at: "2026-07-20T12:00:00.000Z",
    updated_at: "2026-07-25T12:00:00.000Z",
  };
}

function session(
  sessionId,
  projectId,
  title,
  updatedAt,
  messageCount = 1,
) {
  return {
    session_id: sessionId,
    project_id: projectId,
    title,
    created_at: "2026-07-20T12:00:00.000Z",
    updated_at: updatedAt,
    message_count: messageCount,
  };
}
