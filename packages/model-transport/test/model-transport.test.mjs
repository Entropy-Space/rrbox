import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelStreamEventSequenceValidator,
  isModelToolName,
  parseModelDescriptor,
  parseModelToolCall,
  parseModelRequest,
  parseModelStreamEvent,
} from "../src/model-transport.ts";
import { HttpNdjsonModelTransport } from "../src/http-ndjson-model-transport.ts";

const modelRequest = {
  session_id: "session-1",
  provider_id: "researchbox-mock",
  model_id: "researchbox-mock",
  system_prompt: "Help with the workspace.",
  messages: [{ role: "user", content: "inspect the workspace" }],
  tools: [],
};

test("parses a model request with a serialized conversation and tools", () => {
  const request = parseModelRequest({
    session_id: "session-1",
    provider_id: "researchbox-mock",
    model_id: "researchbox-mock",
    system_prompt: "Help with the workspace.",
    reasoning_effort: "medium",
    messages: [
      { role: "user", content: "inspect the workspace" },
      {
        role: "assistant",
        content_blocks: [
          { type: "reasoning", reasoning: "I should inspect first." },
          { type: "text", text: "Inspecting." },
          {
            type: "tool_call",
            tool_call_id: "tool-1",
            tool_name: "list_files",
            arguments: { path: "/" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool-1",
        tool_name: "list_files",
        content: "[]",
        is_error: false,
      },
    ],
    tools: [
      {
        name: "list_files",
        description: "List files.",
        parameters: { type: "object" },
      },
    ],
  });

  assert.equal(request.messages[2]?.role, "tool");
  assert.equal(request.tools[0]?.name, "list_files");
  assert.equal(request.reasoning_effort, "medium");
  assert.throws(
    () =>
      parseModelRequest({
        ...modelRequest,
        reasoning_effort: "extreme",
      }),
    /Invalid reasoning_effort/,
  );
});

test("model descriptors default reasoning-effort support independently", () => {
  const descriptor = {
    provider_id: "local-openai",
    provider_display_name: "Local OpenAI",
    model_id: "reasoning-model",
    display_name: "Reasoning model",
    context_window: 128_000,
    max_output_tokens: 8_192,
    supports_tools: true,
    supports_reasoning: true,
  };

  assert.equal(
    parseModelDescriptor(descriptor).supports_reasoning_effort,
    false,
  );
  assert.equal(
    parseModelDescriptor({
      ...descriptor,
      supports_reasoning_effort: true,
    }).supports_reasoning_effort,
    true,
  );
});

test("preserves text, tool, result, and next-turn reasoning order", () => {
  const messages = [
    { role: "user", content: "Inspect the README." },
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
        { type: "reasoning", reasoning: "The title identifies the project." },
        { type: "text", text: "This is the ResearchBox project." },
      ],
    },
  ];

  const request = parseModelRequest({ ...modelRequest, messages });

  assert.deepEqual(request.messages, messages);
});

test("allows empty user and tool content while requiring assistant blocks", () => {
  const request = parseModelRequest({
    ...modelRequest,
    messages: [
      { role: "user", content: "" },
      {
        role: "assistant",
        content_blocks: [
          {
            type: "tool_call",
            tool_call_id: "tool-1",
            tool_name: "list_files",
            arguments: { path: "/" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool-1",
        tool_name: "list_files",
        content: "",
        is_error: false,
      },
    ],
  });

  assert.equal(request.messages[0]?.content, "");
  assert.equal(request.messages[2]?.content, "");
  assert.throws(
    () => parseModelRequest({ ...modelRequest, session_id: "  " }),
    /session_id must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseModelRequest({
        ...modelRequest,
        messages: [{ role: "assistant", content_blocks: [] }],
      }),
    /at least one content block/,
  );
});

test("rejects unsafe model tool names", () => {
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "tool_call_end",
        content_index: 0,
        tool_call: {
          tool_call_id: "tool-1",
          tool_name: "Run shell",
          arguments: { path: "/" },
        },
      }),
    /Invalid tool name/,
  );
});

test("parses each model tool with its exact discriminated arguments", () => {
  const multilineContent = "first line\n\n  indented line\nlast line\n";
  const multilineOldText = "before\n  nested\n";
  const multilineNewText = "after\n\n  still nested\n";
  const calls = [
    {
      tool_call_id: "list-1",
      tool_name: "list_files",
      arguments: { path: "/src", ignored: "not forwarded" },
    },
    {
      tool_call_id: "read-1",
      tool_name: "read_file",
      arguments: { path: "/README.md" },
    },
    {
      tool_call_id: "search-1",
      tool_name: "search_files",
      arguments: {
        path: "/src",
        query: "ModelToolName",
        ignored: "not forwarded",
      },
    },
    {
      tool_call_id: "write-1",
      tool_name: "write_file",
      arguments: { path: "/notes.md", content: multilineContent },
    },
    {
      tool_call_id: "replace-1",
      tool_name: "replace_text",
      arguments: {
        path: "/src/index.ts",
        old_text: multilineOldText,
        new_text: multilineNewText,
      },
    },
    {
      tool_call_id: "remove-1",
      tool_name: "remove_file",
      arguments: { path: "/obsolete.md" },
    },
  ];

  assert.deepEqual(calls.map(parseModelToolCall), [
    {
      tool_call_id: "list-1",
      tool_name: "list_files",
      arguments: { path: "/src" },
    },
    calls[1],
    {
      tool_call_id: "search-1",
      tool_name: "search_files",
      arguments: { path: "/src", query: "ModelToolName" },
    },
    calls[3],
    calls[4],
    calls[5],
  ]);
  for (const name of [
    "list_files",
    "read_file",
    "search_files",
    "write_file",
    "replace_text",
    "remove_file",
    "run_python",
  ]) {
    assert.equal(isModelToolName(name), true);
  }
  assert.equal(isModelToolName("Run shell"), false);
  assert.deepEqual(
    parseModelToolCall({
      tool_call_id: "python-1",
      tool_name: "run_python",
      arguments: { code: "print(42)" },
    }),
    {
      tool_call_id: "python-1",
      tool_name: "run_python",
      arguments: { code: "print(42)" },
    },
  );
});

test("validates tool arguments according to the tool name", () => {
  assert.throws(
    () =>
      parseModelToolCall({
        tool_call_id: "search-1",
        tool_name: "search_files",
        arguments: { path: "/src" },
      }),
    /query must be a string/,
  );
  assert.throws(
    () =>
      parseModelToolCall({
        tool_call_id: "search-1",
        tool_name: "search_files",
        arguments: { path: "/src", query: "" },
      }),
    /query must be a string/,
  );
  assert.throws(
    () =>
      parseModelToolCall({
        tool_call_id: "write-1",
        tool_name: "write_file",
        arguments: { path: "/notes.md" },
      }),
    /content must be a string/,
  );
  assert.throws(
    () =>
      parseModelToolCall({
        tool_call_id: "replace-1",
        tool_name: "replace_text",
        arguments: {
          path: "/notes.md",
          old_text: "before",
        },
      }),
    /new_text must be a string/,
  );
  assert.throws(
    () =>
      parseModelToolCall({
        tool_call_id: "read-1",
        tool_name: "read_file",
        arguments: { path: "" },
      }),
    /path must be a string/,
  );
  for (const argumentsValue of [
    {},
    { path: "" },
    { path: 42 },
    { path: "/notes.md", recursive: true },
  ]) {
    assert.throws(
      () =>
        parseModelToolCall({
          tool_call_id: "remove-1",
          tool_name: "remove_file",
          arguments: argumentsValue,
        }),
      /path must be a string|must contain exactly/,
    );
  }
});

test("NDJSON transport preserves multiline mutation arguments", async () => {
  const writeCall = {
    tool_call_id: "write-1",
    tool_name: "write_file",
    arguments: {
      path: "/notes.md",
      content: "line one\n\nline three\n",
    },
  };
  const argumentsJson = JSON.stringify(writeCall.arguments);
  const lifecycle = [
    { type: "tool_call_start", content_index: 0 },
    {
      type: "tool_call_delta",
      content_index: 0,
      tool_call_id_delta: writeCall.tool_call_id,
      tool_name_delta: writeCall.tool_name,
      arguments_delta: argumentsJson,
    },
    {
      type: "tool_call_end",
      content_index: 0,
      tool_call: writeCall,
    },
    { type: "done" },
  ];
  const events = await collectStream(
    `${lifecycle.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );

  assert.deepEqual(events, lifecycle);
});

test("rejects a model stream that ends without done", async () => {
  await assert.rejects(
    collectStream(
      '{"type":"text_start","content_index":0}\n' +
        '{"type":"text_delta","content_index":0,"text_delta":"partial"}\n' +
        '{"type":"text_end","content_index":0}\n',
    ),
    /ended before a done event/,
  );
});

test("stops consuming model events at done", async () => {
  const events = await collectStream(
    '{"type":"done"}\n' +
      '{"type":"text_start","content_index":0}\n',
  );

  assert.deepEqual(events, [{ type: "done" }]);
});

test("invokes fetch with the active global scope", async () => {
  let callCount = 0;
  const transport = new HttpNdjsonModelTransport(
    "http://localhost/api/mock",
    function fetchWithReceiver() {
      assert.equal(this, globalThis);
      callCount += 1;
      return Promise.resolve(
        new Response('{"type":"done"}\n', {
          headers: { "content-type": "application/x-ndjson" },
        }),
      );
    },
  );

  assert.deepEqual(await collectTransport(transport), [{ type: "done" }]);
  assert.equal(callCount, 1);
});

test("validates monotonic block lifecycle and tool identity", () => {
  const sequence = new ModelStreamEventSequenceValidator();
  const call = {
    tool_call_id: "write-1",
    tool_name: "write_file",
    arguments: {
      path: "/notes.md",
      content: "first\n\nsecond\n",
    },
  };
  for (const event of [
    { type: "text_start", content_index: 0 },
    { type: "text_delta", content_index: 0, text_delta: "before" },
    { type: "text_end", content_index: 0 },
    { type: "reasoning_start", content_index: 1 },
    {
      type: "reasoning_delta",
      content_index: 1,
      reasoning_delta: "consider",
    },
    { type: "reasoning_end", content_index: 1 },
    { type: "text_start", content_index: 2 },
    { type: "text_delta", content_index: 2, text_delta: "after" },
    { type: "text_end", content_index: 2 },
    { type: "tool_call_start", content_index: 3 },
    {
      type: "tool_call_delta",
      content_index: 3,
      tool_call_id_delta: call.tool_call_id,
      tool_name_delta: call.tool_name,
      arguments_delta: JSON.stringify(call.arguments),
    },
    {
      type: "tool_call_end",
      content_index: 3,
      tool_call: call,
    },
    { type: "done" },
  ]) {
    sequence.accept(event);
  }
  sequence.assertComplete();

  const duplicateIndex = new ModelStreamEventSequenceValidator();
  duplicateIndex.accept({ type: "text_start", content_index: 0 });
  assert.throws(
    () => duplicateIndex.accept({ type: "text_start", content_index: 0 }),
    /Expected content_index 1/,
  );

  const mismatched = new ModelStreamEventSequenceValidator();
  mismatched.accept({ type: "tool_call_start", content_index: 0 });
  mismatched.accept({
    type: "tool_call_delta",
    content_index: 0,
    tool_call_id_delta: "read-1",
    tool_name_delta: "read_file",
    arguments_delta: '{"path":"/README.md"}',
  });
  assert.throws(
    () =>
      mismatched.accept({
        type: "tool_call_end",
        content_index: 0,
        tool_call: {
          tool_call_id: "other",
          tool_name: "read_file",
          arguments: { path: "/README.md" },
        },
      }),
    /does not match deltas/,
  );

  const duplicateToolCallId = new ModelStreamEventSequenceValidator();
  for (const contentIndex of [0, 1]) {
    duplicateToolCallId.accept({
      type: "tool_call_start",
      content_index: contentIndex,
    });
    duplicateToolCallId.accept({
      type: "tool_call_delta",
      content_index: contentIndex,
      tool_call_id_delta: "read-1",
      tool_name_delta: "read_file",
      arguments_delta: '{"path":"/README.md"}',
    });
    const end = {
      type: "tool_call_end",
      content_index: contentIndex,
      tool_call: {
        tool_call_id: "read-1",
        tool_name: "read_file",
        arguments: { path: "/README.md" },
      },
    };
    if (contentIndex === 0) {
      duplicateToolCallId.accept(end);
    } else {
      assert.throws(
        () => duplicateToolCallId.accept(end),
        /Duplicate completed tool_call_id: read-1/,
      );
    }
  }
});

async function collectStream(body) {
  const transport = new HttpNdjsonModelTransport(
    "http://localhost/api/mock",
    async () =>
      new Response(body, {
        headers: { "content-type": "application/x-ndjson" },
      }),
  );
  return collectTransport(transport);
}

async function collectTransport(transport) {
  const events = [];
  for await (const event of transport.stream(
    modelRequest,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}
