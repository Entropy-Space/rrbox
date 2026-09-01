import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebSearchAgentPlugin,
} from "../src/web-search-agent-plugin.ts";

test("registers an open_url tool with HTML, Markdown, and summary formats", async () => {
  const completionPrompts = [];
  const plugin = createWebSearchAgentPlugin({
    async search() {
      throw new Error("The URL tool must not use web search.");
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "auto",
    default_workflow: "auto-summary",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
    async fetch() {
      return new Response(
        "<title>Example</title><h1>Web page</h1><p>Page evidence.</p>",
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const tools = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model(prompt) {
      completionPrompts.push(prompt);
      return {
        text: "A concise page summary.\n\nSources\n- https://example.com/page",
        provider_id: "openai",
        model_id: "summary-model",
      };
    },
  });
  const tool = tools.find((candidate) => candidate.name === "open_url");
  assert.ok(tool);
  assert.equal(tools[0]?.name, "web_search");

  const progressUpdates = [];
  const result = await tool.execute(
    "call",
    { url: "https://example.com/page", format: "summary" },
    new AbortController().signal,
    (update) => progressUpdates.push(update),
  );

  assert.equal(
    result.content[0].text,
    "A concise page summary.\n\nSources\n- https://example.com/page",
  );
  assert.deepEqual(
    progressUpdates.map((update) => update.details.progress?.phase),
    ["opening", "generating-summary"],
  );
  assert.match(completionPrompts[0], /untrusted data/u);
  assert.match(completionPrompts[0], /Page evidence/u);
  assert.equal(result.details.format, "summary");
  assert.equal(result.details.source, "direct");
  assert.deepEqual(
    {
      model: result.details.synthesis.model,
      fallback_used: result.details.synthesis.fallback_used,
    },
    {
      model: "openai/summary-model",
      fallback_used: false,
    },
  );
});

test("reports rejected URL targets as a tool error without making a request", async () => {
  let fetched = false;
  const plugin = createWebSearchAgentPlugin({
    async search() {
      throw new Error("Unexpected search");
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "auto",
    default_workflow: "none",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
    async fetch() {
      fetched = true;
      throw new Error("Unexpected fetch");
    },
  });
  const tool = plugin.createTools({
    project_id: "project",
    session_id: "session",
  }).find((candidate) => candidate.name === "open_url");
  assert.ok(tool);

  const result = await tool.execute(
    "call",
    { url: "http://127.0.0.1:8080/", format: "markdown" },
    new AbortController().signal,
  );

  assert.equal(result.isError, true);
  assert.equal(fetched, false);
  assert.match(result.content[0].text, /public hostname/u);
});
