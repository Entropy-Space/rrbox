import assert from "node:assert/strict";
import test from "node:test";
import { handleMockModelRequest } from "../src/index.ts";

test("streams a tool call for workspace inspection", async () => {
  const response = await handleMockModelRequest(
    new Request("http://localhost/api/mock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createModelRequest("inspect the workspace")),
    }),
  );

  assert.equal(response.status, 200);
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events[0]?.type, "tool_call");
  assert.equal(events.at(-1)?.type, "done");
});

test("creates a workspace note and continues from the write result", async () => {
  const firstResponse = await handleMockModelRequest(
    createRequest(createModelRequest("Create a workspace note")),
  );
  const firstEvents = await readEvents(firstResponse);
  assert.deepEqual(
    {
      type: firstEvents[0]?.type,
      tool_name: firstEvents[0]?.tool_name,
      path: firstEvents[0]?.arguments.path,
    },
    {
      type: "tool_call",
      tool_name: "write_file",
      path: "/notes/agent-note.md",
    },
  );
  assert.match(firstEvents[0]?.arguments.content, /ResearchBox mock agent/);
  assert.equal(firstEvents.at(-1)?.stop_reason, "tool_use");

  const request = createModelRequest("Create a workspace note");
  request.messages.push(
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
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
  assert.match(
    continuationEvents
      .filter((event) => event.type === "text_delta")
      .map((event) => event.text_delta)
      .join(""),
    /created `\/notes\/agent-note\.md`/,
  );
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
