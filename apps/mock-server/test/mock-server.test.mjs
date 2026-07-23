import assert from "node:assert/strict";
import test from "node:test";
import { handleMockModelRequest } from "../src/index.ts";

test("streams reasoning, text, then a tool call for workspace inspection", async () => {
  const response = await handleMockModelRequest(
    new Request("http://localhost/api/mock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createModelRequest("inspect the workspace")),
    }),
  );

  assert.equal(response.status, 200);
  const events = await readEvents(response);
  assertToolTurnLifecycle(events);
  assert.match(blockText(events, "reasoning"), /inspect .* workspace context/i);
  assert.match(blockText(events, "text"), /inspect the workspace first/i);

  const toolCall = events.find((event) => event.type === "tool_call_end")
    ?.tool_call;
  assert.deepEqual(
    {
      tool_name: toolCall?.tool_name,
      arguments: toolCall?.arguments,
    },
    {
      tool_name: "list_files",
      arguments: { path: "/" },
    },
  );
});

test("creates a workspace note and continues from the write result", async () => {
  const firstResponse = await handleMockModelRequest(
    createRequest(createModelRequest("Create a workspace note")),
  );
  const firstEvents = await readEvents(firstResponse);
  assertToolTurnLifecycle(firstEvents);
  assert.match(
    blockText(firstEvents, "reasoning"),
    /workspace note .* easy to inspect/i,
  );
  const expectedIntroduction = [
    "I’ll create a **short workspace note** now.",
    "",
    "- It will live in the project workspace.",
    "- You can inspect it from the file browser.",
  ].join("\n");
  assert.equal(blockText(firstEvents, "text"), expectedIntroduction);
  assert.deepEqual(blockDeltas(firstEvents, "text"), [
    "I’ll create a *",
    "*short workspace note",
    "*",
    "* now.\n\n",
    "- It will live in the project workspace.\n",
    "- You can inspect it from the file browser.",
  ]);
  const firstToolCall = firstEvents.find(
    (event) => event.type === "tool_call_end",
  )?.tool_call;
  assert.deepEqual(
    {
      tool_name: firstToolCall?.tool_name,
      path: firstToolCall?.arguments.path,
    },
    {
      tool_name: "write_file",
      path: "/notes/agent-note.md",
    },
  );
  assert.match(firstToolCall?.arguments.content, /ResearchBox mock agent/);
  assert.equal(firstEvents.at(-1)?.stop_reason, "tool_use");

  const request = createModelRequest("Create a workspace note");
  request.messages.push(
    {
      role: "assistant",
      content_blocks: [
        {
          type: "reasoning",
          reasoning: "A workspace note will be useful.",
        },
        {
          type: "text",
          text: "I’ll create a short workspace note now.",
        },
        {
          type: "tool_call",
          tool_call_id: "write-note",
          tool_name: "write_file",
          arguments: {
            path: "/notes/agent-note.md",
            content: "# Agent note\n",
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "write-note",
      tool_name: "write_file",
      content: JSON.stringify({
        path: "/notes/agent-note.md",
        change_kind: "created",
      }),
      is_error: false,
    },
  );
  const continuation = await handleMockModelRequest(createRequest(request));
  const continuationEvents = await readEvents(continuation);
  assert.deepEqual(nonDeltaLifecycle(continuationEvents), [
    { type: "reasoning_start", content_index: 0 },
    { type: "reasoning_end", content_index: 0 },
    { type: "text_start", content_index: 1 },
    { type: "text_end", content_index: 1 },
    { type: "done" },
  ]);
  assert.match(
    blockText(continuationEvents, "reasoning"),
    /result is available.*summarize the outcome/i,
  );
  const expectedResult = [
    "**Created:** `/notes/agent-note.md`",
    "",
    "```md",
    "# Agent note",
    "- Worker-hosted agent core",
    "- Portable virtual filesystem",
    "- Versioned JSON boundary",
    "```",
    "",
    "The note is ready in the file browser, and the change card records its path and line statistics.",
  ].join("\n");
  assert.equal(blockText(continuationEvents, "text"), expectedResult);
  assert.deepEqual(blockDeltas(continuationEvents, "text"), [
    "*",
    "*Created:",
    "*",
    "* `/notes/agent-note.md`\n\n",
    "`",
    "``md\n",
    "# Agent note\n",
    "- Worker-hosted agent core\n",
    "- Portable virtual filesystem\n",
    "- Versioned JSON boundary\n",
    "`",
    "``\n\n",
    "The note is ready in the file browser, and the change card records its path and line statistics.",
  ]);
});

test("rejects malformed model requests", async () => {
  const response = await handleMockModelRequest(
    new Request("http://localhost/api/mock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "missing fields" }),
    }),
  );

  assert.equal(response.status, 400);
});

function createModelRequest(prompt) {
  return {
    session_id: "session-1",
    provider_id: "researchbox",
    model_id: "researchbox-mock",
    system_prompt: "Help with the workspace.",
    messages: [{ role: "user", content: prompt }],
    tools: [
      {
        name: "list_files",
        description: "List files in the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "read_file",
        description: "Read a file from the workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write a complete file in the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "replace_text",
        description: "Replace one exact text fragment in a workspace file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
    ],
  };
}

function createRequest(modelRequest) {
  return new Request("http://localhost/api/mock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(modelRequest),
  });
}

async function readEvents(response) {
  assert.equal(response.status, 200);
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function assertToolTurnLifecycle(events) {
  assert.deepEqual(nonDeltaLifecycle(events), [
    { type: "reasoning_start", content_index: 0 },
    { type: "reasoning_end", content_index: 0 },
    { type: "text_start", content_index: 1 },
    { type: "text_end", content_index: 1 },
    { type: "tool_call_start", content_index: 2 },
    {
      type: "tool_call_end",
      content_index: 2,
      tool_call: events.find((event) => event.type === "tool_call_end")
        ?.tool_call,
    },
    { type: "done", stop_reason: "tool_use" },
  ]);

  assertBlockLifecycle(events, "reasoning", 0);
  assertBlockLifecycle(events, "text", 1);
  assertBlockLifecycle(events, "tool_call", 2);

  for (const event of events) {
    if (!event.type.endsWith("_delta")) continue;
    const expectedIndex =
      event.type === "reasoning_delta"
        ? 0
        : event.type === "text_delta"
          ? 1
          : 2;
    assert.equal(event.content_index, expectedIndex);
  }

  const toolDelta = events.find((event) => event.type === "tool_call_delta");
  const toolEnd = events.find((event) => event.type === "tool_call_end");
  assert.equal(toolDelta?.tool_call_id_delta, toolEnd?.tool_call.tool_call_id);
  assert.equal(toolDelta?.tool_name_delta, toolEnd?.tool_call.tool_name);
  assert.deepEqual(
    JSON.parse(toolDelta?.arguments_delta),
    toolEnd?.tool_call.arguments,
  );
}

function nonDeltaLifecycle(events) {
  return events.filter((event) => !event.type.endsWith("_delta"));
}

function blockText(events, blockType) {
  return blockDeltas(events, blockType).join("");
}

function blockDeltas(events, blockType) {
  const deltaType =
    blockType === "reasoning" ? "reasoning_delta" : "text_delta";
  const field = blockType === "reasoning" ? "reasoning_delta" : "text_delta";
  return events
    .filter((event) => event.type === deltaType)
    .map((event) => event[field]);
}

function assertBlockLifecycle(events, blockType, contentIndex) {
  const lifecycle = events.filter(
    (event) =>
      event.type === `${blockType}_start` ||
      event.type === `${blockType}_delta` ||
      event.type === `${blockType}_end`,
  );

  assert.equal(lifecycle[0]?.type, `${blockType}_start`);
  assert.equal(lifecycle.at(-1)?.type, `${blockType}_end`);
  assert.ok(
    lifecycle.slice(1, -1).every(
      (event) =>
        event.type === `${blockType}_delta` &&
        event.content_index === contentIndex,
    ),
  );
}
