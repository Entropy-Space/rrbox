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

test("model block lifecycles preserve reasoning, text, and tool order", async () => {
  const toolCall = {
    tool_call_id: "read-1",
    tool_name: "read_file",
    arguments: { path: "/README.md" },
  };
  const streamFn = createModelStreamFn({
    async *stream() {
      yield { type: "reasoning_start", content_index: 0 };
      yield {
        type: "reasoning_delta",
        content_index: 0,
        reasoning_delta: "Inspect first.",
      };
      yield { type: "reasoning_end", content_index: 0 };
      yield { type: "text_start", content_index: 1 };
      yield {
        type: "text_delta",
        content_index: 1,
        text_delta: "I will read the file.",
      };
      yield { type: "text_end", content_index: 1 };
      yield { type: "tool_call_start", content_index: 2 };
      yield {
        type: "tool_call_delta",
        content_index: 2,
        tool_call_id_delta: toolCall.tool_call_id,
        tool_name_delta: toolCall.tool_name,
        arguments_delta: JSON.stringify(toolCall.arguments),
      };
      yield {
        type: "tool_call_end",
        content_index: 2,
        tool_call: toolCall,
      };
      yield { type: "done", stop_reason: "tool_use" };
    },
  });

  const events = [];
  for await (const event of streamFn(
    model,
    { systemPrompt: "Work carefully.", messages: [], tools: [] },
    { sessionId: "session-1" },
  )) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ],
  );
  assert.deepEqual(events.at(-1).message.content, [
    { type: "thinking", thinking: "Inspect first." },
    { type: "text", text: "I will read the file." },
    {
      type: "toolCall",
      id: "read-1",
      name: "read_file",
      arguments: { path: "/README.md" },
    },
  ]);
});

test("stream errors discard incomplete fragmented tool calls", async () => {
  const completeToolCall = {
    tool_call_id: "read-1",
    tool_name: "read_file",
    arguments: { path: "/README.md" },
  };
  const streamFn = createModelStreamFn({
    async *stream() {
      yield { type: "tool_call_start", content_index: 0 };
      yield {
        type: "tool_call_delta",
        content_index: 0,
        tool_call_id_delta: completeToolCall.tool_call_id,
        tool_name_delta: completeToolCall.tool_name,
        arguments_delta: JSON.stringify(completeToolCall.arguments),
      };
      yield {
        type: "tool_call_end",
        content_index: 0,
        tool_call: completeToolCall,
      };
      yield { type: "tool_call_start", content_index: 1 };
      yield {
        type: "tool_call_delta",
        content_index: 1,
        tool_call_id_delta: "unfinished-",
        tool_name_delta: "write_",
        arguments_delta: "{\"path\":\"/notes.md\"",
      };
      throw new Error("Connection lost");
    },
  });

  const events = [];
  for await (const event of streamFn(
    model,
    { systemPrompt: "Work carefully.", messages: [], tools: [] },
    { sessionId: "session-1" },
  )) {
    events.push(event);
  }

  const terminal = events.at(-1);
  assert.equal(terminal.type, "error");
  assert.equal(terminal.reason, "error");
  assert.match(terminal.error.errorMessage, /Connection lost/);
  assert.deepEqual(terminal.error.content, [
    {
      type: "toolCall",
      id: "read-1",
      name: "read_file",
      arguments: { path: "/README.md" },
    },
  ]);
});

test("aborted streams discard incomplete fragmented tool calls", async () => {
  const controller = new AbortController();
  const streamFn = createModelStreamFn({
    async *stream() {
      yield { type: "tool_call_start", content_index: 0 };
      yield {
        type: "tool_call_delta",
        content_index: 0,
        tool_call_id_delta: "unfinished-",
        tool_name_delta: "read_",
        arguments_delta: "{\"path\":",
      };
      controller.abort();
      throw new Error("Request interrupted");
    },
  });

  const events = [];
  for await (const event of streamFn(
    model,
    { systemPrompt: "Work carefully.", messages: [], tools: [] },
    { sessionId: "session-1", signal: controller.signal },
  )) {
    events.push(event);
  }

  const terminal = events.at(-1);
  assert.equal(terminal.type, "error");
  assert.equal(terminal.reason, "aborted");
  assert.equal(terminal.error.stopReason, "aborted");
  assert.deepEqual(terminal.error.content, []);
});

test("forwards Pi reasoning effort only when explicitly supported", async () => {
  const requests = [];
  const streamFn = createModelStreamFn({
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "done", stop_reason: "stop" };
    },
  });
  const models = [
    { ...model, reasoning: true },
    { ...model, reasoning: true, supports_reasoning_effort: false },
    { ...model, reasoning: true, supports_reasoning_effort: true },
  ];

  for (const [index, candidate] of models.entries()) {
    for await (const event of streamFn(
      candidate,
      { systemPrompt: "Work carefully.", messages: [], tools: [] },
      {
        sessionId: `session-${index}`,
        reasoning: "high",
      },
    )) {
      assert.notEqual(event.type, "error");
    }
  }

  assert.equal("reasoning_effort" in requests[0], false);
  assert.equal("reasoning_effort" in requests[1], false);
  assert.equal(requests[2].reasoning_effort, "high");
});

test("explicit none overrides Pi while default leaves effort unset", async () => {
  const requests = [];
  const transport = {
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "done", stop_reason: "stop" };
    },
  };
  const reasoningModel = {
    ...model,
    reasoning: true,
    reasoning_efforts: ["none", "low", "medium", "high"],
  };

  for await (const event of createModelStreamFn(transport)(
    reasoningModel,
    { systemPrompt: "Work carefully.", messages: [], tools: [] },
    { sessionId: "session-default" },
  )) {
    assert.notEqual(event.type, "error");
  }
  for await (const event of createModelStreamFn(transport, "none")(
    reasoningModel,
    { systemPrompt: "Work carefully.", messages: [], tools: [] },
    { sessionId: "session-none", reasoning: "high" },
  )) {
    assert.notEqual(event.type, "error");
  }

  assert.equal("reasoning_effort" in requests[0], false);
  assert.equal(requests[1].reasoning_effort, "none");
});

test("forwards registered plugin tools to the model", async () => {
  const requests = [];
  const streamFn = createModelStreamFn({
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "done", stop_reason: "stop" };
    },
  });

  for await (const event of streamFn(
    model,
    {
      systemPrompt: "Work carefully.",
      messages: [],
      tools: [{
        name: "run_python",
        label: "Run Python",
        description: "Run stateless Python.",
        parameters: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        },
        async execute() {
          throw new Error("Not executed by this test.");
        },
      }],
    },
    { sessionId: "session-python" },
  )) {
    assert.notEqual(event.type, "error");
  }

  assert.deepEqual(requests[0].tools, [{
    name: "run_python",
    description: "Run stateless Python.",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
  }]);
});

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
  const removeArguments = { path: "/obsolete.md" };
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
          {
            type: "toolCall",
            id: "remove-1",
            name: "remove_file",
            arguments: removeArguments,
          },
        ]),
        toolResult("write-1", "write_file"),
        toolResult("replace-1", "replace_text"),
        toolResult("remove-1", "remove_file"),
      ],
      tools: [],
    },
    { sessionId: "session-1" },
  );

  const events = [];
  for await (const event of stream) events.push(event);

  assert.equal(requests.length, 1);
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(requests[0].messages[0].content_blocks, [
    {
      type: "tool_call",
      tool_call_id: "write-1",
      tool_name: "write_file",
      arguments: writeArguments,
    },
    {
      type: "tool_call",
      tool_call_id: "replace-1",
      tool_name: "replace_text",
      arguments: replaceArguments,
    },
    {
      type: "tool_call",
      tool_call_id: "remove-1",
      tool_name: "remove_file",
      arguments: removeArguments,
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
