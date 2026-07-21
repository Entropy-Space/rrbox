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
    ],
  };
}
