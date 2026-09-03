import assert from "node:assert/strict";
import test from "node:test";
import {
  CallId,
  ReasoningEffortId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  ModelTransportLlmAdapter,
  toModelRequest,
} from "../src/index.ts";

const BASE_OPTIONS = {
  provider: "provider-alpha",
  model: "model-alpha",
  messages: [],
  sessionId: "session-alpha",
};

class ScriptedTransport {
  constructor(events) {
    this.events = events;
    this.requests = [];
    this.signals = [];
  }

  async *stream(request, signal) {
    this.requests.push(request);
    this.signals.push(signal);
    for (const event of this.events) yield event;
  }
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("translates the DSH transcript and tool schemas to ModelRequest", async () => {
  const callId = CallId("read-call");
  const messages = [
    createUserMessage({
      content: [
        { type: "text", text: "Read" },
        { type: "text", text: "the note." },
      ],
      source: { kind: "user" },
    }),
    createAssistantMessage({
      content: [
        { type: "reasoning", text: "I should read it." },
        { type: "text", text: "Checking." },
        {
          type: "tool-call",
          id: callId,
          name: "read_file",
          arguments: JSON.stringify({ path: "/note.txt" }),
        },
      ],
      source: { provider: "provider-alpha", model: "model-alpha" },
    }),
    createToolResultMessage({
      callId,
      content: [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
      isError: false,
    }),
  ];
  const transport = new ScriptedTransport([
    { type: "text_start", content_index: 0 },
    { type: "text_delta", content_index: 0, text_delta: "Done." },
    { type: "text_end", content_index: 0 },
    { type: "done", stop_reason: "stop" },
  ]);
  const adapter = new ModelTransportLlmAdapter(transport);
  const controller = new AbortController();

  await collect(adapter.stream({
    ...BASE_OPTIONS,
    messages,
    system: "Use workspace tools.",
    reasoningEffort: ReasoningEffortId("high"),
    signal: controller.signal,
    tools: [{
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    }],
  }));

  assert.equal(transport.signals[0], controller.signal);
  assert.deepEqual(transport.requests[0], {
    session_id: "session-alpha",
    provider_id: "provider-alpha",
    model_id: "model-alpha",
    system_prompt: "Use workspace tools.",
    reasoning_effort: "high",
    messages: [
      { role: "user", content: "Read\nthe note." },
      {
        role: "assistant",
        content_blocks: [
          { type: "reasoning", reasoning: "I should read it." },
          { type: "text", text: "Checking." },
          {
            type: "tool_call",
            tool_call_id: "read-call",
            tool_name: "read_file",
            arguments: { path: "/note.txt" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "read-call",
        tool_name: "read_file",
        content: "First\nSecond",
        is_error: false,
      },
    ],
    tools: [{
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    }],
  });
});

test("projects validated stream events to DSH chunks", async () => {
  const transport = new ScriptedTransport([
    { type: "reasoning_start", content_index: 0 },
    { type: "reasoning_delta", content_index: 0, reasoning_delta: "Think" },
    { type: "reasoning_end", content_index: 0 },
    { type: "text_start", content_index: 1 },
    { type: "text_delta", content_index: 1, text_delta: "Use a tool." },
    { type: "text_end", content_index: 1 },
    { type: "tool_call_start", content_index: 2 },
    {
      type: "tool_call_delta",
      content_index: 2,
      tool_call_id_delta: "lookup-",
      tool_name_delta: "look",
      arguments_delta: "{\"query\":",
    },
    {
      type: "tool_call_delta",
      content_index: 2,
      tool_call_id_delta: "1",
      tool_name_delta: "up",
      arguments_delta: "\"value\"}",
    },
    {
      type: "tool_call_end",
      content_index: 2,
      tool_call: {
        tool_call_id: "lookup-1",
        tool_name: "lookup",
        arguments: { query: "value" },
      },
    },
    { type: "done", stop_reason: "tool_use" },
  ]);

  const chunks = await collect(
    new ModelTransportLlmAdapter(transport).stream(BASE_OPTIONS),
  );

  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "Think" },
    {
      type: "block-end",
      index: 0,
      block: { type: "reasoning", text: "Think" },
    },
    { type: "block-start", index: 1, blockType: "text" },
    { type: "text-delta", index: 1, text: "Use a tool." },
    {
      type: "block-end",
      index: 1,
      block: { type: "text", text: "Use a tool." },
    },
    { type: "block-start", index: 2, blockType: "tool-call" },
    {
      type: "tool-call-delta",
      index: 2,
      id: "lookup-1",
      name: "lookup",
      argumentsDelta: "{\"query\":\"value\"}",
    },
    {
      type: "block-end",
      index: 2,
      block: {
        type: "tool-call",
        id: "lookup-1",
        name: "lookup",
        arguments: "{\"query\":\"value\"}",
      },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("maps provider-scoped catalog metadata without validating routes", async () => {
  const descriptor = {
    provider_id: "provider-alpha",
    provider_display_name: "Provider Alpha",
    model_id: "model-alpha",
    display_name: "Model Alpha",
    context_window: 128_000,
    max_output_tokens: 8_192,
    supports_tools: true,
    supports_reasoning: true,
    supports_reasoning_effort: true,
    reasoning_efforts: [
      { id: "low", display_name: "Low" },
      { id: "xhigh", display_name: "Extra high" },
    ],
  };
  const catalog = {
    calls: [],
    async listModels(provider, signal) {
      this.calls.push({ provider, signal });
      return [
        descriptor,
        { ...descriptor, provider_id: "provider-beta" },
      ];
    },
  };
  const adapter = new ModelTransportLlmAdapter(
    new ScriptedTransport([]),
    catalog,
  );

  assert.deepEqual(await adapter.listModels("provider-alpha"), [{
    provider: "provider-alpha",
    id: "model-alpha",
    name: "Model Alpha",
    inputModalities: ["text"],
  }]);
  assert.deepEqual(
    await adapter.resolveModel("provider-alpha", "model-alpha"),
    {
      provider: "provider-alpha",
      id: "model-alpha",
      name: "Model Alpha",
      inputModalities: ["text"],
      context: { contextWindow: 128_000 },
      reasoning: {
        efforts: [
          { id: "low", name: "Low" },
          { id: "xhigh", name: "Extra high" },
        ],
      },
    },
  );
  assert.deepEqual(
    await adapter.resolveModel("provider-alpha", "unlisted-model"),
    {
      provider: "provider-alpha",
      id: "unlisted-model",
      name: "unlisted-model",
      inputModalities: ["text"],
    },
  );
  assert.equal(catalog.calls.every((call) => call.provider === "provider-alpha"), true);
});

test("fails closed for controls and content the transport cannot represent", () => {
  assert.throws(
    () => toModelRequest({ ...BASE_OPTIONS, maxTokens: 100 }),
    /cannot represent DSH options: maxTokens/u,
  );
  assert.throws(
    () => toModelRequest({ ...BASE_OPTIONS, temperature: 0 }),
    /temperature/u,
  );
  assert.throws(
    () => toModelRequest({ ...BASE_OPTIONS, stop: [] }),
    /stop/u,
  );
  assert.throws(
    () => toModelRequest({
      ...BASE_OPTIONS,
      messages: [createUserMessage({
        content: [{ type: "image", attachment: {} }],
        source: { kind: "user" },
      })],
    }),
    /Unsupported DSH image block/u,
  );
});

test("rejects unmatched tool results before calling the transport", async () => {
  const transport = new ScriptedTransport([]);
  const adapter = new ModelTransportLlmAdapter(transport);
  const callId = CallId("missing-result");
  const message = createAssistantMessage({
    content: [{
      type: "tool-call",
      id: callId,
      name: "lookup",
      arguments: "{}",
    }],
    source: { provider: "provider-alpha", model: "model-alpha" },
  });

  await assert.rejects(
    collect(adapter.stream({ ...BASE_OPTIONS, messages: [message] })),
    /Missing DSH tool results/u,
  );
  assert.equal(transport.requests.length, 0);
});

test("does not emit success before the transport sequence is complete", async () => {
  const transport = new ScriptedTransport([
    { type: "done", stop_reason: "stop" },
    { type: "text_start", content_index: 0 },
  ]);
  const chunks = [];

  await assert.rejects(async () => {
    for await (const chunk of new ModelTransportLlmAdapter(transport)
      .stream(BASE_OPTIONS)) {
      chunks.push(chunk);
    }
  }, /event after done/u);
  assert.deepEqual(chunks, []);
});

test("honors cancellation before entering the transport", async () => {
  const transport = new ScriptedTransport([]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    collect(new ModelTransportLlmAdapter(transport).stream({
      ...BASE_OPTIONS,
      signal: controller.signal,
    })),
    { name: "AbortError" },
  );
  assert.equal(transport.requests.length, 0);
});
