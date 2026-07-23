import assert from "node:assert/strict";
import test from "node:test";
import {
  createStreamingAssistantEntry,
  createToolResultEntry,
  finalizeAssistantEntry,
  timelineToAgentMessages,
} from "../src/session-codec.ts";

const usage = {
  input: 2,
  output: 3,
  cache_read: 4,
  cache_write: 5,
  total_tokens: 14,
  cost: {
    input: 0.1,
    output: 0.2,
    cache_read: 0.3,
    cache_write: 0.4,
    total: 1,
  },
};

test("timeline entries restore an ordered Pi transcript", () => {
  const timeline = [
    {
      type: "user_message",
      entry_id: "user-1",
      run_id: "run-1",
      created_at: "2026-01-01T00:00:00.001Z",
      content: "Inspect files",
    },
    {
      type: "assistant_message",
      entry_id: "assistant-1",
      run_id: "run-1",
      created_at: "2026-01-01T00:00:00.002Z",
      status: "complete",
      api: "researchbox-mock",
      provider: "researchbox",
      model: "researchbox-mock",
      response_model: "researchbox-mock-2026",
      response_id: "response-1",
      usage,
      stop_reason: "tool_use",
      blocks: [
        {
          type: "reasoning",
          block_id: "reasoning-1",
          text: "I should inspect first.",
          thinking_signature: "thinking-signature",
          redacted: false,
        },
        {
          type: "assistant_text",
          block_id: "text-1",
          text: "I will inspect.",
          text_signature: "text-signature",
        },
        {
          type: "tool_call",
          block_id: "tool-block-1",
          tool_call_id: "provider-tool-1",
          tool_name: "list_files",
          arguments: { path: "/" },
          thought_signature: "tool-signature",
          label: "Listing /",
        },
      ],
    },
    {
      type: "tool_result",
      entry_id: "result-1",
      run_id: "run-1",
      created_at: "2026-01-01T00:00:00.003Z",
      tool_call_block_id: "tool-block-1",
      tool_call_id: "provider-tool-1",
      tool_name: "list_files",
      content: "[]",
      is_error: false,
      summary: "0 entries found",
    },
  ];

  const messages = timelineToAgentMessages(timeline);

  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  assert.deepEqual(messages[1].content, [
    {
      type: "thinking",
      thinking: "I should inspect first.",
      thinkingSignature: "thinking-signature",
      redacted: false,
    },
    {
      type: "text",
      text: "I will inspect.",
      textSignature: "text-signature",
    },
    {
      type: "toolCall",
      id: "provider-tool-1",
      name: "list_files",
      arguments: { path: "/" },
      thoughtSignature: "tool-signature",
    },
  ]);
  assert.equal(messages[1].stopReason, "toolUse");
  assert.equal(messages[1].responseModel, "researchbox-mock-2026");
  assert.equal(messages[1].responseId, "response-1");
  assert.deepEqual(messages[1].usage, {
    input: 2,
    output: 3,
    cacheRead: 4,
    cacheWrite: 5,
    totalTokens: 14,
    cost: {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.3,
      cacheWrite: 0.4,
      total: 1,
    },
  });
  assert.equal(messages[2].toolCallId, "provider-tool-1");
  assert.deepEqual(messages[2].details, { summary: "0 entries found" });
});

test("streaming assistant entries finalize while preserving block identities", () => {
  const partial = assistantMessage(
    [
      { type: "thinking", thinking: "" },
      { type: "text", text: "" },
      {
        type: "toolCall",
        id: "provider-tool-1",
        name: "read_file",
        arguments: {},
      },
    ],
    "toolUse",
  );
  const streaming = createStreamingAssistantEntry(partial, "run-1");
  streaming.blocks = [
    {
      type: "reasoning",
      block_id: "reasoning-block",
      text: "",
    },
    {
      type: "assistant_text",
      block_id: "text-block",
      text: "",
    },
    {
      type: "tool_call",
      block_id: "tool-block",
      tool_call_id: "provider-tool-1",
      tool_name: "read_file",
      arguments: {},
      label: "Reading /README.md",
    },
  ];

  const complete = assistantMessage(
    [
      {
        type: "thinking",
        thinking: "Read the workspace.",
        thinkingSignature: "thinking-signature",
      },
      {
        type: "text",
        text: "I will read the file.",
        textSignature: "text-signature",
      },
      {
        type: "toolCall",
        id: "provider-tool-1",
        name: "read_file",
        arguments: { path: "/README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    "toolUse",
  );
  complete.responseModel = "response-model";
  complete.responseId = "response-id";
  complete.usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
    cost: {
      input: 0.1,
      output: 0.2,
      cacheRead: 0.3,
      cacheWrite: 0.4,
      total: 1,
    },
  };

  const finalized = finalizeAssistantEntry(streaming, complete);

  assert.equal(finalized.entry_id, streaming.entry_id);
  assert.equal(finalized.run_id, "run-1");
  assert.equal(finalized.status, "complete");
  assert.equal(finalized.stop_reason, "tool_use");
  assert.equal(finalized.response_model, "response-model");
  assert.equal(finalized.response_id, "response-id");
  assert.deepEqual(
    finalized.blocks.map((block) => block.block_id),
    ["reasoning-block", "text-block", "tool-block"],
  );
  assert.equal(finalized.blocks[2].label, "Reading /README.md");
  assert.deepEqual(finalized.blocks[2].arguments, { path: "/README.md" });
});

test("tool results retain the internal tool-call block identity and details", () => {
  const message = {
    role: "toolResult",
    toolCallId: "provider-tool-1",
    toolName: "write_file",
    content: [{ type: "text", text: "Saved" }],
    details: {
      summary: "Created · +1 −0",
      file_change: {
        change_id: "change-1",
        tool_call_id: "provider-tool-1",
        path: "/note.md",
        change_kind: "created",
        additions: 1,
        deletions: 0,
        byte_size: 6,
      },
    },
    isError: false,
    timestamp: Date.parse("2026-01-01T00:00:00.003Z"),
  };

  const entry = createToolResultEntry(
    message,
    "run-1",
    "internal-tool-block-1",
  );

  assert.equal(entry.run_id, "run-1");
  assert.equal(entry.tool_call_block_id, "internal-tool-block-1");
  assert.equal(entry.tool_call_id, "provider-tool-1");
  assert.equal(entry.summary, "Created · +1 −0");
  assert.equal(entry.file_change.path, "/note.md");
});

test("streaming timeline entries cannot be restored into a Pi transcript", () => {
  assert.throws(
    () =>
      timelineToAgentMessages([
        {
          type: "assistant_message",
          entry_id: "assistant-1",
          run_id: "run-1",
          created_at: "2026-01-01T00:00:00.001Z",
          status: "streaming",
          api: "researchbox-mock",
          provider: "researchbox",
          model: "researchbox-mock",
          usage,
          blocks: [],
        },
      ]),
    /streaming assistant entry cannot be restored/,
  );
});

function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    content,
    api: "researchbox-mock",
    provider: "researchbox",
    model: "researchbox-mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: Date.parse("2026-01-01T00:00:00.002Z"),
  };
}
