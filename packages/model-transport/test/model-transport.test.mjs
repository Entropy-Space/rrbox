import assert from "node:assert/strict";
import test from "node:test";
import {
  isModelToolName,
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
    messages: [
      { role: "user", content: "inspect the workspace" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
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
});

test("allows empty message content while requiring nonempty identifiers", () => {
  const request = parseModelRequest({
    ...modelRequest,
    messages: [
      { role: "user", content: "" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
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
});

test("rejects unsupported model tools", () => {
  assert.throws(
    () =>
      parseModelStreamEvent({
        type: "tool_call",
        tool_call_id: "tool-1",
        tool_name: "run_shell",
        arguments: { path: "/" },
      }),
    /Unsupported tool/,
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
  ];

  assert.deepEqual(calls.map(parseModelToolCall), [
    {
      tool_call_id: "list-1",
      tool_name: "list_files",
      arguments: { path: "/src" },
    },
    calls[1],
    calls[2],
    calls[3],
  ]);
  for (const name of [
    "list_files",
    "read_file",
    "write_file",
    "replace_text",
  ]) {
    assert.equal(isModelToolName(name), true);
  }
  assert.equal(isModelToolName("run_shell"), false);
});

test("validates tool arguments according to the tool name", () => {
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
});

test("NDJSON transport preserves multiline mutation arguments", async () => {
  const writeCall = {
    type: "tool_call",
    tool_call_id: "write-1",
    tool_name: "write_file",
    arguments: {
      path: "/notes.md",
      content: "line one\n\nline three\n",
    },
  };
  const events = await collectStream(
    `${JSON.stringify(writeCall)}\n${JSON.stringify({ type: "done" })}\n`,
  );

  assert.deepEqual(events, [writeCall, { type: "done" }]);
});

test("rejects a model stream that ends without done", async () => {
  await assert.rejects(
    collectStream('{"type":"text_delta","text_delta":"partial"}\n'),
    /ended before a done event/,
  );
});

test("stops consuming model events at done", async () => {
  const events = await collectStream(
    '{"type":"done"}\n' +
      '{"type":"tool_call","tool_call_id":"late","tool_name":"read_file","arguments":{"path":"/README.md"}}\n',
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
