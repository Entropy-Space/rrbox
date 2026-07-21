import assert from "node:assert/strict";
import test from "node:test";
import { handleMockModelRequest } from "../src/index.ts";

test("streams a tool call for workspace inspection", async () => {
  const response = await handleMockModelRequest(
    new Request("http://localhost/api/mock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-1",
        prompt: "inspect the workspace",
        tool_results: [],
      }),
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
