import assert from "node:assert/strict";
import test from "node:test";
import {
  parseModelRequest,
  parseModelStreamEvent,
} from "../src/model-transport.ts";
import { HttpNdjsonModelTransport } from "../src/http-ndjson-model-transport.ts";

const modelRequest = {
  session_id: "session-1",
  prompt: "inspect the workspace",
  tool_results: [],
};

test("parses a model request with serialized tool results", () => {
  const request = parseModelRequest({
    session_id: "session-1",
    prompt: "inspect the workspace",
    tool_results: [
      {
        tool_call_id: "tool-1",
        tool_name: "list_files",
        content: "[]",
        is_error: false,
      },
    ],
  });

  assert.equal(request.tool_results[0]?.tool_call_id, "tool-1");
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
