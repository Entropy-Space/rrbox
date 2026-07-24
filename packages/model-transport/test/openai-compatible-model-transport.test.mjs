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
      content_blocks: [
        { type: "reasoning", reasoning: "The README is relevant. " },
        { type: "text", text: "I will inspect it." },
        {
          type: "tool_call",
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
              capabilities: {
                toolcall: true,
                reasoning: true,
                reasoning_effort: true,
              },
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
      supports_reasoning_effort: true,
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
      supports_reasoning_effort: false,
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

  assert.deepEqual(
    await collect(
      transport,
      new AbortController().signal,
      { ...modelRequest, reasoning_effort: "medium" },
    ),
    [
    { type: "text_start", content_index: 0 },
    { type: "text_delta", content_index: 0, text_delta: "Done" },
    { type: "text_end", content_index: 0 },
    { type: "done", stop_reason: "stop" },
    ],
  );
  assert.deepEqual(sentBody, {
    model: "gpt-test",
    reasoning_effort: "medium",
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

test("only projects canonical reasoning when explicitly enabled", async () => {
  let sentBody;
  const transport = createTransport(
    async (_input, init) => {
      sentBody = JSON.parse(init.body);
      return sseResponse(["data: [DONE]\n\n"]);
    },
    { send_reasoning_content: true },
  );

  await collect(transport);

  assert.equal(
    sentBody.messages[2].reasoning_content,
    "The README is relevant. ",
  );
});

test("serializes text, tool, result, and next-turn reasoning in turn order", async () => {
  let sentBody;
  const transport = createTransport(
    async (_input, init) => {
      sentBody = JSON.parse(init.body);
      return sseResponse(["data: [DONE]\n\n"]);
    },
    { send_reasoning_content: true },
  );
  const request = {
    ...modelRequest,
    messages: [
      { role: "user", content: "Inspect README." },
      {
        role: "assistant",
        content_blocks: [
          { type: "text", text: "I will inspect it." },
          {
            type: "tool_call",
            tool_call_id: "read-1",
            tool_name: "read_file",
            arguments: { path: "/README.md" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "read-1",
        tool_name: "read_file",
        content: "# ResearchBox",
        is_error: false,
      },
      {
        role: "assistant",
        content_blocks: [
          { type: "reasoning", reasoning: "The title is decisive." },
          { type: "text", text: "This is ResearchBox." },
        ],
      },
      { role: "user", content: "Continue." },
    ],
  };

  await collect(transport, new AbortController().signal, request);

  assert.deepEqual(sentBody.messages.slice(1), [
    { role: "user", content: "Inspect README." },
    {
      role: "assistant",
      content: "I will inspect it.",
      tool_calls: [
        {
          id: "read-1",
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
      tool_call_id: "read-1",
      content: "# ResearchBox",
    },
    {
      role: "assistant",
      content: "This is ResearchBox.",
      reasoning_content: "The title is decisive.",
    },
    { role: "user", content: "Continue." },
  ]);
});

test("normalizes provider-visible reasoning in deterministic block order", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"plan ","content":"answer ","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"/README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  assert.deepEqual(await collect(transport), [
    { type: "reasoning_start", content_index: 0 },
    {
      type: "reasoning_delta",
      content_index: 0,
      reasoning_delta: "plan ",
    },
    { type: "reasoning_end", content_index: 0 },
    { type: "text_start", content_index: 1 },
    {
      type: "text_delta",
      content_index: 1,
      text_delta: "answer ",
    },
    { type: "text_end", content_index: 1 },
    { type: "tool_call_start", content_index: 2 },
    {
      type: "tool_call_delta",
      content_index: 2,
      tool_call_id_delta: "call-1",
      tool_name_delta: "read_file",
      arguments_delta: '{"path":"/README.md"}',
    },
    {
      type: "tool_call_end",
      content_index: 2,
      tool_call: {
        tool_call_id: "call-1",
        tool_name: "read_file",
        arguments: { path: "/README.md" },
      },
    },
    { type: "done", stop_reason: "tool_use" },
  ]);
});

test("assigns new indices when text and reasoning blocks repeat", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"reasoning":"first"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"second"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"thinking":"third"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"fourth"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  assert.deepEqual(await collect(transport), [
    { type: "reasoning_start", content_index: 0 },
    {
      type: "reasoning_delta",
      content_index: 0,
      reasoning_delta: "first",
    },
    { type: "reasoning_end", content_index: 0 },
    { type: "text_start", content_index: 1 },
    { type: "text_delta", content_index: 1, text_delta: "second" },
    { type: "text_end", content_index: 1 },
    { type: "reasoning_start", content_index: 2 },
    {
      type: "reasoning_delta",
      content_index: 2,
      reasoning_delta: "third",
    },
    { type: "reasoning_end", content_index: 2 },
    { type: "text_start", content_index: 3 },
    { type: "text_delta", content_index: 3, text_delta: "fourth" },
    { type: "text_end", content_index: 3 },
    { type: "done", stop_reason: "stop" },
  ]);
});

test("rejects conflicting reasoning aliases", async () => {
  const transport = createTransport(async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"one","thinking":"two"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  await assert.rejects(
    collect(transport),
    /conflicting reasoning deltas/,
  );
});

test("serializes prior mutation calls without truncating multiline arguments", async () => {
  let sentBody;
  const transport = createTransport(async (_input, init) => {
    sentBody = JSON.parse(init.body);
    return sseResponse(["data: [DONE]\n\n"]);
  });
  const writeArguments = {
    path: "/notes.md",
    content: "first line\n\n  indented line\n",
  };
  const replaceArguments = {
    path: "/notes.md",
    old_text: "first line\n",
    new_text: "replacement\n\n",
  };
  const mutationRequest = {
    ...modelRequest,
    messages: [
      { role: "user", content: "Update notes." },
      {
        role: "assistant",
        content_blocks: [
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
        ],
      },
      {
        role: "tool",
        tool_call_id: "write-1",
        tool_name: "write_file",
        content: "File written",
        is_error: false,
      },
      {
        role: "tool",
        tool_call_id: "replace-1",
        tool_name: "replace_text",
        content: "Text replaced",
        is_error: false,
      },
    ],
  };

  await collect(
    transport,
    new AbortController().signal,
    mutationRequest,
  );

  assert.deepEqual(
    sentBody.messages[2].tool_calls.map((toolCall) => ({
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })),
    [
      {
        name: "write_file",
        arguments: JSON.stringify(writeArguments),
      },
      {
        name: "replace_text",
        arguments: JSON.stringify(replaceArguments),
      },
    ],
  );
});

test("serializes and streams exact remove_file calls", async () => {
  let sentBody;
  const removeArguments = { path: "/obsolete.md" };
  const transport = createTransport(async (_input, init) => {
    sentBody = JSON.parse(init.body);
    return sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"remove-2","function":{"name":"remove_file","arguments":"{\\"path\\":\\"/later.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  });
  const removeRequest = {
    ...modelRequest,
    messages: [
      { role: "user", content: "Remove the obsolete file." },
      {
        role: "assistant",
        content_blocks: [
          {
            type: "tool_call",
            tool_call_id: "remove-1",
            tool_name: "remove_file",
            arguments: removeArguments,
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "remove-1",
        tool_name: "remove_file",
        content: "File removed",
        is_error: false,
      },
    ],
    tools: [
      {
        name: "remove_file",
        description: "Remove one workspace file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
  };

  assert.deepEqual(
    await collect(
      transport,
      new AbortController().signal,
      removeRequest,
    ),
    [
      { type: "tool_call_start", content_index: 0 },
      {
        type: "tool_call_delta",
        content_index: 0,
        tool_call_id_delta: "remove-2",
        tool_name_delta: "remove_file",
        arguments_delta: '{"path":"/later.md"}',
      },
      {
        type: "tool_call_end",
        content_index: 0,
        tool_call: {
          tool_call_id: "remove-2",
          tool_name: "remove_file",
          arguments: { path: "/later.md" },
        },
      },
      { type: "done", stop_reason: "tool_use" },
    ],
  );
  assert.deepEqual(sentBody.messages[2], {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "remove-1",
        type: "function",
        function: {
          name: "remove_file",
          arguments: JSON.stringify(removeArguments),
        },
      },
    ],
  });
  assert.deepEqual(sentBody.messages[3], {
    role: "tool",
    tool_call_id: "remove-1",
    content: "File removed",
  });
  assert.deepEqual(sentBody.tools, [
    {
      type: "function",
      function: removeRequest.tools[0],
    },
  ]);
});

test("rejects malformed streamed remove_file arguments", async () => {
  for (const argumentsJson of [
    "{}",
    '{"path":"/obsolete.md","recursive":true}',
  ]) {
    const transport = createTransport(async () =>
      sseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "remove-invalid",
                    function: {
                      name: "remove_file",
                      arguments: argumentsJson,
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );

    await assert.rejects(
      collect(transport),
      /Malformed tool arguments|Invalid tool call/,
    );
  }
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
    { type: "text_start", content_index: 0 },
    { type: "text_delta", content_index: 0, text_delta: "Checking" },
    { type: "text_end", content_index: 0 },
    { type: "tool_call_start", content_index: 1 },
    {
      type: "tool_call_delta",
      content_index: 1,
      tool_call_id_delta: "call_",
      tool_name_delta: "read_",
      arguments_delta: '{"pa',
    },
    { type: "tool_call_start", content_index: 2 },
    {
      type: "tool_call_delta",
      content_index: 2,
      tool_call_id_delta: "call_2",
      tool_name_delta: "list_files",
      arguments_delta: '{"path":"/"}',
    },
    {
      type: "tool_call_delta",
      content_index: 1,
      tool_call_id_delta: "1",
      tool_name_delta: "file",
      arguments_delta: 'th":"/README.md"}',
    },
    {
      type: "tool_call_end",
      content_index: 1,
      tool_call: {
        tool_call_id: "call_1",
        tool_name: "read_file",
        arguments: { path: "/README.md" },
      },
    },
    {
      type: "tool_call_end",
      content_index: 2,
      tool_call: {
        tool_call_id: "call_2",
        tool_name: "list_files",
        arguments: { path: "/" },
      },
    },
    { type: "done", stop_reason: "tool_use" },
  ]);
});

test("preserves fragmented multiline mutation arguments exactly", async () => {
  const writeArguments = JSON.stringify({
    path: "/notes.md",
    content: "first line\n\n  indented line\nlast line\n",
  });
  const replaceArguments = JSON.stringify({
    path: "/src/index.ts",
    old_text: "const before = true;\n  keep();\n",
    new_text: "const after = true;\n\n  keep();\n",
  });
  const writeSplit = Math.floor(writeArguments.length / 2);
  const replaceSplit = Math.floor(replaceArguments.length / 2);
  const transport = createTransport(async () =>
    sseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "write-1",
                  function: {
                    name: "write_file",
                    arguments: writeArguments.slice(0, writeSplit),
                  },
                },
                {
                  index: 1,
                  id: "replace-1",
                  function: {
                    name: "replace_text",
                    arguments: replaceArguments.slice(0, replaceSplit),
                  },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: writeArguments.slice(writeSplit),
                  },
                },
                {
                  index: 1,
                  function: {
                    arguments: replaceArguments.slice(replaceSplit),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]),
  );

  assert.deepEqual(await collect(transport), [
    { type: "tool_call_start", content_index: 0 },
    {
      type: "tool_call_delta",
      content_index: 0,
      tool_call_id_delta: "write-1",
      tool_name_delta: "write_file",
      arguments_delta: writeArguments.slice(0, writeSplit),
    },
    { type: "tool_call_start", content_index: 1 },
    {
      type: "tool_call_delta",
      content_index: 1,
      tool_call_id_delta: "replace-1",
      tool_name_delta: "replace_text",
      arguments_delta: replaceArguments.slice(0, replaceSplit),
    },
    {
      type: "tool_call_delta",
      content_index: 0,
      arguments_delta: writeArguments.slice(writeSplit),
    },
    {
      type: "tool_call_delta",
      content_index: 1,
      arguments_delta: replaceArguments.slice(replaceSplit),
    },
    {
      type: "tool_call_end",
      content_index: 0,
      tool_call: {
        tool_call_id: "write-1",
        tool_name: "write_file",
        arguments: JSON.parse(writeArguments),
      },
    },
    {
      type: "tool_call_end",
      content_index: 1,
      tool_call: {
        tool_call_id: "replace-1",
        tool_name: "replace_text",
        arguments: JSON.parse(replaceArguments),
      },
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
    { type: "text_start", content_index: 0 },
    { type: "text_delta", content_index: 0, text_delta: "partial" },
    { type: "text_end", content_index: 0 },
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
    value: { type: "text_start", content_index: 0 },
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

function createTransport(fetchRequest, options = {}) {
  return new OpenAiCompatibleModelTransport({
    provider_id: "local-openai",
    provider_display_name: "Local OpenAI",
    models_endpoint: "/api/providers/local-openai/models",
    chat_completions_endpoint:
      "/api/providers/local-openai/chat/completions",
    fetch_request: fetchRequest,
    ...options,
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

async function collect(
  transport,
  signal = new AbortController().signal,
  request = modelRequest,
) {
  const events = [];
  for await (const event of transport.stream(request, signal)) {
    events.push(event);
  }
  return events;
}
