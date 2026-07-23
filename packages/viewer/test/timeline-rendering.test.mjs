import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssistantRunPresentation,
  buildTimelineRows,
  findFinalAssistantEntry,
  getAssistantText,
  getToolResultCopy,
  indexToolResults,
} from "../src/timeline-rendering.ts";

test("timeline rows preserve canonical order and group assistant turns by run", () => {
  const firstAssistant = assistantEntry("assistant-1", "run-1", [
    textBlock("text-before", "Before."),
    toolCallBlock("call-block-1", "provider-call"),
  ], {
    stop_reason: "tool_use",
  });
  const firstResult = toolResult(
    "result-1",
    "run-1",
    "call-block-1",
    "provider-call",
  );
  const finalAssistant = assistantEntry("assistant-2", "run-1", [
    textBlock("text-after", "After."),
    textBlock("text-conclusion", "Conclusion."),
  ], {
    stop_reason: "stop",
  });
  const timeline = [
    userEntry("user-1", "run-1"),
    firstAssistant,
    firstResult,
    finalAssistant,
    userEntry("user-2", "run-2"),
    assistantEntry("assistant-3", "run-2", []),
  ];

  const rows = buildTimelineRows(timeline);

  assert.deepEqual(
    rows.map((row) => row.type),
    ["user", "assistant_run", "user", "assistant_run"],
  );
  assert.deepEqual(
    rows[1].entries.map((entry) => entry.entry_id),
    ["assistant-1", "result-1", "assistant-2"],
  );
  assert.equal(
    findFinalAssistantEntry(rows[1].entries, false)?.entry_id,
    "assistant-2",
  );
  assert.equal(findFinalAssistantEntry(rows[1].entries, true), null);
  assert.equal(
    getAssistantText(finalAssistant),
    "After.\n\nConclusion.",
  );

  const presentation = buildAssistantRunPresentation(
    rows[1].entries,
    false,
  );
  assert.deepEqual(
    presentation.flatMap((turn) =>
      turn.blocks.map(({ block }) => block.type)
    ),
    ["assistant_text", "tool_call", "assistant_text", "assistant_text"],
  );
  assert.equal(
    presentation[0].blocks[1].tool_result?.entry_id,
    "result-1",
  );
  assert.equal(presentation[0].action_content, null);
  assert.equal(
    presentation[1].action_content,
    "After.\n\nConclusion.",
  );
});

test("tool results are matched by internal block ID, not provider call ID", () => {
  const entries = [
    assistantEntry("assistant-1", "run-1", [
      toolCallBlock("call-block-1", "reused-provider-call"),
      toolCallBlock("call-block-2", "reused-provider-call"),
    ]),
    toolResult(
      "result-1",
      "run-1",
      "call-block-1",
      "reused-provider-call",
      "first",
    ),
    toolResult(
      "result-2",
      "run-1",
      "call-block-2",
      "reused-provider-call",
      "second",
    ),
  ];

  const results = indexToolResults(entries);

  assert.equal(results.size, 2);
  assert.equal(results.get("call-block-1")?.content, "first");
  assert.equal(results.get("call-block-2")?.content, "second");
});

test("presentation marks only the latest reasoning block as active", () => {
  const reasoningThenText = assistantEntry(
    "assistant-1",
    "run-1",
    [
      {
        type: "reasoning",
        block_id: "reasoning-1",
        text: "Checked the workspace.",
      },
      textBlock("text-1", "Writing the answer."),
    ],
    {
      status: "streaming",
      stop_reason: undefined,
    },
  );

  const [turn] = buildAssistantRunPresentation(
    [reasoningThenText],
    true,
  );

  assert.equal(turn.blocks[0].is_latest_block, false);
  assert.equal(turn.blocks[1].is_latest_block, true);
  assert.equal(turn.waiting_state, null);
});

test("presentation marks a partial inactive stream as interrupted", () => {
  const partial = assistantEntry(
    "assistant-1",
    "run-1",
    [textBlock("text-1", "A partial response.")],
    {
      status: "streaming",
      stop_reason: undefined,
    },
  );

  const [turn] = buildAssistantRunPresentation([partial], false);

  assert.equal(turn.waiting_state, "interrupted");
  assert.equal(turn.action_content, null);
});

test("generic failed-tool summaries retain the provider error detail", () => {
  const result = {
    ...toolResult(
      "result-1",
      "run-1",
      "call-block-1",
      "provider-call",
      "Permission denied",
    ),
    is_error: true,
    summary: "Tool failed",
  };

  assert.deepEqual(getToolResultCopy(result), {
    summary: "Tool failed",
    error_detail: "Permission denied",
  });
});

function userEntry(entryId, runId) {
  return {
    type: "user_message",
    entry_id: entryId,
    run_id: runId,
    created_at: "2026-07-23T00:00:00.000Z",
    content: "Hello",
  };
}

function assistantEntry(
  entryId,
  runId,
  blocks,
  overrides = {},
) {
  return {
    type: "assistant_message",
    entry_id: entryId,
    run_id: runId,
    created_at: "2026-07-23T00:00:00.000Z",
    status: "complete",
    stop_reason: "stop",
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
    blocks,
    ...overrides,
  };
}

function textBlock(blockId, text) {
  return {
    type: "assistant_text",
    block_id: blockId,
    text,
  };
}

function toolCallBlock(blockId, toolCallId) {
  return {
    type: "tool_call",
    block_id: blockId,
    tool_call_id: toolCallId,
    tool_name: "read_file",
    arguments: { path: "/README.md" },
  };
}

function toolResult(
  entryId,
  runId,
  toolCallBlockId,
  toolCallId,
  content = "done",
) {
  return {
    type: "tool_result",
    entry_id: entryId,
    run_id: runId,
    created_at: "2026-07-23T00:00:00.000Z",
    tool_call_block_id: toolCallBlockId,
    tool_call_id: toolCallId,
    tool_name: "read_file",
    content,
    is_error: false,
  };
}
