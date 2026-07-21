import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAgentMessages,
  encodeAgentMessages,
} from "../src/session-codec.ts";

test("Pi transcripts round-trip through a snake_case persisted codec", () => {
  const messages = [
    { role: "user", content: "Inspect files", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect." },
        {
          type: "toolCall",
          id: "tool-1",
          name: "list_files",
          arguments: { path: "/" },
          thoughtSignature: "opaque",
        },
      ],
      api: "researchbox-mock",
      provider: "researchbox",
      model: "researchbox-mock",
      responseModel: "researchbox-mock-2026",
      responseId: "response-1",
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 14,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "list_files",
      content: [{ type: "text", text: "[]" }],
      isError: false,
      timestamp: 3,
    },
  ];

  const encoded = encodeAgentMessages(messages);
  assert.equal(encoded[1].response_model, "researchbox-mock-2026");
  assert.equal(encoded[1].content[1].type, "tool_call");
  assert.equal(encoded[2].tool_call_id, "tool-1");
  assert.deepEqual(decodeAgentMessages(encoded), messages);
});

test("the transcript codec rejects unknown stored message roles", () => {
  assert.throws(
    () => decodeAgentMessages([{ role: "custom", content: [] }]),
    /role is invalid/,
  );
  assert.throws(
    () => encodeAgentMessages([{ role: "custom", content: [] }]),
    /role is not supported/,
  );
});
