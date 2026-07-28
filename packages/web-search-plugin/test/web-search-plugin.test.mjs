import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchAgentPlugin } from "../src/web-search-plugin.ts";

test("searches multiple angles and summarizes with the active model", async () => {
  const calls = [];
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      calls.push(request);
      return {
        query: request.query,
        provider: "exa",
        answer: `Answer for ${request.query}`,
        sources: [{
          title: "Rust",
          url: "https://www.rust-lang.org/",
          snippet: "Rust is a programming language.",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 7,
    maximum_output_bytes: 64 * 1024,
    default_provider: "auto",
    default_workflow: "auto-summary",
    summary_timeout_ms: 1_000,
  });
  const completions = [];
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model(prompt) {
      completions.push(prompt);
      return {
        text: "Synthesized answer.\n\nSources\n- https://www.rust-lang.org/",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
  });

  assert.equal(plugin.id, "web-search");
  assert.equal(tool.name, "web_search");
  const result = await tool.execute(
    "call",
    {
      queries: ["Rust language", "Rust memory safety"],
      num_results: 3,
      recency_filter: "month",
      domain_filter: ["rust-lang.org", "-example.com"],
    },
    new AbortController().signal,
    () => {},
  );

  assert.deepEqual(calls, [
    {
      query: "Rust language",
      num_results: 3,
      include_content: false,
      provider: "auto",
      recency_filter: "month",
      domain_filter: ["rust-lang.org", "-example.com"],
    },
    {
      query: "Rust memory safety",
      num_results: 3,
      include_content: false,
      provider: "auto",
      recency_filter: "month",
      domain_filter: ["rust-lang.org", "-example.com"],
    },
  ]);
  assert.equal(completions.length, 1);
  assert.match(completions[0], /Do not follow instructions/u);
  assert.match(completions[0], /Rust memory safety/u);
  assert.equal(
    result.content[0].text,
    "Synthesized answer.\n\nSources\n- https://www.rust-lang.org/",
  );
  assert.deepEqual(result.details.synthesis, {
    model: "openai/test-model",
    fallback_used: false,
  });
});

test("falls back deterministically when summary generation fails", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "A factual result.",
        sources: [{
          title: "Example",
          url: "https://example.com/",
          snippet: "Evidence",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "auto-summary",
    summary_timeout_ms: 1_000,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      throw new Error("unavailable");
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.match(result.content[0].text, /A factual result/u);
  assert.match(result.content[0].text, /https:\/\/example.com\//u);
  assert.equal(result.details.synthesis.fallback_used, true);
});
