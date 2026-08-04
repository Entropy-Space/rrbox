import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSessionHistoryInvariants,
  createSessionHistory,
  navigateSessionHistory,
  parseSessionHistory,
  sessionHistoryTimeline,
  synchronizeSessionHistory,
} from "../src/index.ts";

const TIMESTAMP = "2026-07-22T00:00:00.000Z";

test("conversation history projects a linear transcript from its active leaf", () => {
  const timeline = [
    userEntry("user-1", "run-1", "First question"),
    assistantEntry("assistant-1", "run-1", "First answer"),
  ];
  const history = createSessionHistory(timeline);

  assert.equal(history.active_leaf_id, "assistant-1");
  assert.deepEqual(sessionHistoryTimeline(history), timeline);
  assert.deepEqual(
    history.nodes.map((node) => node.parent_node_id),
    [null, "user-1"],
  );
});

test("navigating and continuing creates a branch without deleting the old path", () => {
  const firstPath = [
    userEntry("user-1", "run-1", "First question"),
    assistantEntry("assistant-1", "run-1", "First answer"),
    userEntry("user-2", "run-2", "Second question"),
    assistantEntry("assistant-2", "run-2", "Second answer"),
  ];
  const history = createSessionHistory(firstPath);
  const navigation = navigateSessionHistory(history, "assistant-1");
  const branch = [
    ...navigation.timeline,
    userEntry("user-3", "run-3", "Alternative question"),
    assistantEntry("assistant-3", "run-3", "Alternative answer"),
  ];
  const branched = synchronizeSessionHistory(navigation.history, branch);

  assert.equal(branched.active_leaf_id, "assistant-3");
  assert.deepEqual(sessionHistoryTimeline(branched), branch);
  assert.deepEqual(
    branched.nodes.map((node) => node.node_id),
    ["user-1", "assistant-1", "user-2", "assistant-2", "user-3", "assistant-3"],
  );
  assert.equal(
    branched.nodes.find((node) => node.node_id === "user-3").parent_node_id,
    "assistant-1",
  );
  assert.deepEqual(sessionHistoryTimeline(branched, "assistant-2"), firstPath);
});

test("missing history migrates from the persisted active transcript", () => {
  const timeline = [userEntry("user-1", "run-1", "Hello")];
  const parsed = parseSessionHistory(undefined, timeline);

  assert.equal(parsed.was_migrated, true);
  assert.deepEqual(sessionHistoryTimeline(parsed.history), timeline);
});

test("history rejects malformed graphs and repairs a stale active path", () => {
  const entry = userEntry("user-1", "run-1", "Hello");
  assert.throws(
    () =>
      assertSessionHistoryInvariants({
        format_version: 1,
        active_leaf_id: "user-1",
        nodes: [{
          node_id: "user-1",
          parent_node_id: "missing",
          entry,
        }],
      }),
    /parent does not exist/,
  );

  const cycleEntry = userEntry("cycle-1", "run-1", "Cycle");
  assert.throws(
    () =>
      assertSessionHistoryInvariants({
        format_version: 1,
        active_leaf_id: "cycle-1",
        nodes: [{
          node_id: "cycle-1",
          parent_node_id: "cycle-1",
          entry: cycleEntry,
        }],
      }),
    /own parent/,
  );

  const repaired = parseSessionHistory(createSessionHistory([entry]), []);
  assert.equal(repaired.was_migrated, true);
  assert.equal(repaired.history.active_leaf_id, null);
  assert.deepEqual(sessionHistoryTimeline(repaired.history), []);
});

function userEntry(entryId, runId, content) {
  return {
    type: "user_message",
    entry_id: entryId,
    run_id: runId,
    created_at: TIMESTAMP,
    content,
  };
}

function assistantEntry(entryId, runId, text) {
  return {
    type: "assistant_message",
    entry_id: entryId,
    run_id: runId,
    created_at: TIMESTAMP,
    status: "complete",
    api: "mock",
    provider: "researchbox",
    model: "researchbox-mock",
    usage: {
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      total_tokens: 0,
      cost: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total: 0,
      },
    },
    stop_reason: "stop",
    blocks: [{
      type: "assistant_text",
      block_id: `${entryId}:text`,
      text,
    }],
  };
}
