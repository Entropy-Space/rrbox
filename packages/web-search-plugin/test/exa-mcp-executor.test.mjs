import assert from "node:assert/strict";
import test from "node:test";
import { ExaMcpWebSearchExecutor } from "../src/exa-mcp-executor.ts";

test("calls only the fixed Exa MCP tool and parses an SSE result", async () => {
  let captured;
  const executor = new ExaMcpWebSearchExecutor({
    timeout_ms: 1_000,
    maximum_results: 5,
    max_output_bytes: 64 * 1024,
    async fetch(url, init) {
      captured = { url, init };
      return new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":"1","result":{"content":[{"type":"text","text":"Title: Example\\nURL: https://example.com"}]}}\n\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });

  const output = await executor.search({
    query: "example",
    num_results: 3,
    include_content: false,
    provider: "auto",
    recency_filter: "week",
    domain_filter: ["example.com", "-old.example.com"],
  });

  assert.equal(captured.url, "https://mcp.exa.ai/mcp");
  assert.equal(captured.init.redirect, "error");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.params.name, "web_search_exa");
  assert.deepEqual(body.params.arguments, {
    query: "example site:example.com -site:old.example.com past week",
    numResults: 3,
    livecrawl: "fallback",
    type: "auto",
    contextMaxCharacters: 64 * 1024,
  });
  assert.deepEqual(output, {
    query: "example",
    provider: "exa",
    answer:
      "The provider returned this source without an excerpt.\nSource: Example (https://example.com)",
    sources: [{
      title: "Example",
      url: "https://example.com",
      snippet: "",
    }],
  });
});

test("rejects requests above the configured result ceiling", async () => {
  const executor = new ExaMcpWebSearchExecutor({
    timeout_ms: 1_000,
    maximum_results: 2,
    max_output_bytes: 64 * 1024,
    async fetch() {
      throw new Error("fetch should not run");
    },
  });

  await assert.rejects(
    executor.search({
      query: "example",
      num_results: 3,
      include_content: false,
      provider: "auto",
    }),
    /between 1 and 2/u,
  );
});

test("closing the executor aborts an active search", async () => {
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const executor = new ExaMcpWebSearchExecutor({
    timeout_ms: 10_000,
    maximum_results: 2,
    max_output_bytes: 64 * 1024,
    async fetch(_url, init) {
      started();
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });

  const search = executor.search({
    query: "example",
    num_results: 2,
    include_content: false,
    provider: "auto",
  });
  await startedPromise;
  executor.close();

  await assert.rejects(search, { name: "AbortError" });
});
