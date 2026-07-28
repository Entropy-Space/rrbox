import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchAgentPlugin } from "../src/web-search-plugin.ts";

test("exposes one bounded web_search tool only when composed", async () => {
  const calls = [];
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      calls.push(request);
      return "Title: Rust\nURL: https://www.rust-lang.org/";
    },
    close() {},
  }, 7);
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
  });

  assert.equal(plugin.id, "web-search");
  assert.equal(tool.name, "web_search");
  const result = await tool.execute(
    "call",
    {
      query: "Rust language",
      num_results: 3,
      recency_filter: "month",
    },
    new AbortController().signal,
    () => {},
  );

  assert.deepEqual(calls, [{
    query: "Rust language",
    num_results: 3,
    recency_filter: "month",
  }]);
  assert.equal(
    result.content[0].text,
    "Title: Rust\nURL: https://www.rust-lang.org/",
  );
});
