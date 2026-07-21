import assert from "node:assert/strict";
import test from "node:test";
import { OpenAiCompatibleModelTransport } from "../src/openai-compatible-model-transport.ts";

const modelRequest = {
  session_id: "session-1",
  provider_id: "local-openai",
  model_id: "gpt-test",
  system_prompt: "Work carefully.",
  messages: [
    { role: "user", content: "Inspect README." },
    {
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [
        {
          tool_call_id: "previous-call",
          tool_name: "read_file",
          arguments: { path: "/README.md" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "previous-call",
      tool_name: "read_file",
      content: "# ResearchBox",
      is_error: false,
    },
    { role: "user", content: "Summarize it." },
  ],
  tools: [
    {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
};

test("discovers and normalizes OpenAI-compatible models", async () => {
  let callCount = 0;
  const controller = new AbortController();
  const transport = createTransport(function fetchWithReceiver(
    input,
    init,
  ) {
    assert.equal(this, globalThis);
    assert.equal(input, "/api/providers/local-openai/models");
    assert.equal(init.method, "GET");
    assert.equal(init.signal, controller.signal);
    callCount += 1;
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          { id: "plain-model" },
          {
            id: "gpt-test",
            x_tokn_router: {
              name: "GPT Test",
              capabilities: { toolcall: true, reasoning: true },
              limit: { context: 200_000, output: 32_000 },
            },
          },
        ],
      }),
    );
  });

  assert.deepEqual(await transport.listModels(controller.signal), [
    {
      provider_id: "local-openai",
      provider_display_name: "Local OpenAI",
      model_id: "gpt-test",
      display_name: "GPT Test",
      context_window: 200_000,
      max_output_tokens: 32_000,
      supports_tools: true,
      supports_reasoning: true,
    },
    {
      provider_id: "local-openai",
      provider_display_name: "Local OpenAI",
      model_id: "plain-model",
      display_name: "plain-model",
      context_window: null,
      max_output_tokens: null,
      supports_tools: true,
      supports_reasoning: false,
    },
  ]);
  assert.equal(callCount, 1);
});

test("serializes the complete conversation and tool schemas", async () => {
  let sentBody;
  const transport = createTransport(async (input, init) => {
    assert.equal(input, "/api/providers/local-openai/chat/completions");
    assert.equal(init.method, "POST");
    sentBody = JSON.parse(init.body);
    return sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"Done"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  });

  assert.deepEqual(await collect(transport), [
    { type: "text_delta", text_delta: "Done" },
    { type: "done", stop_reason: "stop" },
  ]);
  assert.deepEqual(sentBody, {
    model: "gpt-test",
    messages: [
      { role: "system", content: "Work carefully." },
      { role: "user", content: "Inspect README." },
      {
        role: "assistant",
        content: "I will inspect it.",
        tool_calls: [
          {
            id: "previous-call",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"/README.md"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "previous-call",
        content: "# ResearchBox",
      },
      { role: "user", content: "Summarize it." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ],
    stream: true,
  });
});

test("assembles fragmented and multiple streamed tool calls", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"Checking"}}]}\n',
      "\n",
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"read_","arguments":"{\\"pa"}},{"index":1,"id":"call_2","function":{"name":"list_files","arguments":"{\\"path\\":\\"/\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"file","arguments":"th\\":\\"/README.md\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  assert.deepEqual(await collect(transport), [
    { type: "text_delta", text_delta: "Checking" },
    {
      type: "tool_call",
      tool_call_id: "call_1",
      tool_name: "read_file",
      arguments: { path: "/README.md" },
    },
    {
      type: "tool_call",
      tool_call_id: "call_2",
      tool_name: "list_files",
      arguments: { path: "/" },
    },
    { type: "done", stop_reason: "tool_use" },
  ]);
});

test("preserves length stops and rejects truncated tool calls", async () => {
  const lengthTransport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  assert.deepEqual(await collect(lengthTransport), [
    { type: "text_delta", text_delta: "partial" },
    { type: "done", stop_reason: "length" },
  ]);

  const truncatedToolTransport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"/README.md\\"}"}}]},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  await assert.rejects(
    collect(truncatedToolTransport),
    /truncated a tool call at the token limit/,
  );
});

test("rejects deprecated function_call finish reasons", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"function_call"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  await assert.rejects(
    collect(transport),
    /Unsupported OpenAI-compatible finish_reason: function_call/,
  );
});

test("rejects a tool_calls finish reason without a tool call", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  await assert.rejects(
    collect(transport),
    /reported tool calls without returning one/,
  );
});

test("rejects duplicate streamed tool call ids", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"duplicate-call","function":{"name":"read_file","arguments":"{\\"path\\":\\"/README.md\\"}"}},{"index":1,"id":"duplicate-call","function":{"name":"list_files","arguments":"{\\"path\\":\\"/\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  await assert.rejects(
    collect(transport),
    /duplicate tool call id: duplicate-call/,
  );
});

test("reports HTTP and streamed API errors", async () => {
  const httpTransport = createTransport(async () =>
    Response.json(
      { error: { message: "model unavailable" } },
      { status: 503 },
    ),
  );
  await assert.rejects(
    collect(httpTransport),
    /Chat completions endpoint returned 503: model unavailable/,
  );

  const streamTransport = createTransport(async () =>
    sseResponse([
      'data: {"error":{"message":"upstream disconnected"}}\n\n',
    ]),
  );
  await assert.rejects(
    collect(streamTransport),
    /OpenAI-compatible endpoint error: upstream disconnected/,
  );
});

test("requires the terminal [DONE] event", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
    ]),
  );

  await assert.rejects(collect(transport), /ended before \[DONE\]/);
});

test("honors abort while buffered events remain", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"one"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"two"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  const controller = new AbortController();
  const iterator = transport.stream(modelRequest, controller.signal);

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", text_delta: "one" },
  });
  const abortReason = new Error("cancel requested");
  controller.abort(abortReason);
  await assert.rejects(iterator.next(), (error) => error === abortReason);
});

test("does not consume events after [DONE]", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      "data: [DONE]\n\n",
      "data: this is not JSON\n\n",
    ]),
  );

  assert.deepEqual(await collect(transport), [
    { type: "done", stop_reason: "stop" },
  ]);
});

function createTransport(fetchRequest) {
  return new OpenAiCompatibleModelTransport({
    provider_id: "local-openai",
    provider_display_name: "Local OpenAI",
    models_endpoint: "/api/providers/local-openai/models",
    chat_completions_endpoint:
      "/api/providers/local-openai/chat/completions",
    fetch_request: fetchRequest,
  });
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function collect(transport, signal = new AbortController().signal) {
  const events = [];
  for await (const event of transport.stream(modelRequest, signal)) {
    events.push(event);
  }
  return events;
}
