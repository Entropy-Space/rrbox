import assert from "node:assert/strict";
import test from "node:test";
import { createModelStreamFn } from "../src/pi-stream.ts";

const model = {
  id: "test-model",
  name: "Test model",
  api: "researchbox-mock",
  provider: "researchbox",
  baseUrl: "/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

test("Pi transcript conversion preserves exact mutation arguments", async () => {
  const writeArguments = {
    path: "/notes.md",
    content: "first line\n\n  indented line\n",
  };
  const replaceArguments = {
    path: "/notes.md",
    old_text: "first line\n",
    new_text: "replacement\n\n",
  };
  const requests = [];
  const streamFn = createModelStreamFn({
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "done", stop_reason: "stop" };
    },
  });
  const stream = streamFn(
    model,
    {
      systemPrompt: "Work carefully.",
      messages: [
        assistantMessage([
          {
            type: "toolCall",
            id: "write-1",
            name: "write_file",
            arguments: writeArguments,
          },
          {
            type: "toolCall",
            id: "replace-1",
            name: "replace_text",
            arguments: replaceArguments,
          },
        ]),
        toolResult("write-1", "write_file"),
        toolResult("replace-1", "replace_text"),
      ],
      tools: [],
    },
    { sessionId: "session-1" },
  );

  const events = [];
  for await (const event of stream) events.push(event);

  assert.equal(requests.length, 1);
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(requests[0].messages[0].tool_calls, [
    {
      tool_call_id: "write-1",
      tool_name: "write_file",
      arguments: writeArguments,
    },
    {
      tool_call_id: "replace-1",
      tool_name: "replace_text",
      arguments: replaceArguments,
    },
  ]);
});

test("Pi transcript conversion rejects malformed mutation arguments", async () => {
  let transportStarted = false;
  const streamFn = createModelStreamFn({
    async *stream() {
      transportStarted = true;
      yield { type: "done", stop_reason: "stop" };
    },
  });
  const stream = streamFn(
    model,
    {
      systemPrompt: "Work carefully.",
      messages: [
        assistantMessage([
          {
            type: "toolCall",
            id: "write-1",
            name: "write_file",
            arguments: { path: "/notes.md" },
          },
        ]),
        toolResult("write-1", "write_file"),
      ],
      tools: [],
    },
    { sessionId: "session-1" },
  );

  const events = [];
  for await (const event of stream) events.push(event);

  assert.equal(transportStarted, false);
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).error.errorMessage, /content must be a string/);
});

function assistantMessage(content) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
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
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(toolCallId, toolName) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "Complete" }],
    isError: false,
    timestamp: 2,
  };
}
