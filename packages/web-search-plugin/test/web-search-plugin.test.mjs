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
  const {
    duration_ms: durationMs,
    token_estimate: tokenEstimate,
    ...synthesis
  } = result.details.synthesis;
  assert.ok(durationMs >= 0);
  assert.equal(tokenEstimate, 15);
  assert.deepEqual(synthesis, {
    model: "openai/test-model",
    fallback_used: false,
    reviewed: false,
    edited: false,
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

test("summary-review returns only the user-approved synthesis", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: `Evidence for ${request.query}`,
        sources: [{
          title: request.query,
          url: `https://example.com/${request.query.slice(-1)}`,
          snippet: "Evidence",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "auto",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
  });
  const reviewRequests = [];
  let summaryPrompt;
  const requestedSummaryModels = [];
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model(prompt, _signal, model) {
      summaryPrompt = prompt;
      requestedSummaryModels.push(model);
      if (model) throw new Error("Selected model is temporarily unavailable.");
      return {
        text: "Draft summary",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    async request_summary_review(request) {
      reviewRequests.push(request);
      if (request.stage === "select-evidence") {
        return {
          decision: "summarize",
          approved_text: "",
          selected_section_ids: ["1"],
          feedback_text: "",
          summary_model: {
            provider_id: "local-openai",
            model_id: "summary-model",
          },
        };
      }
      return {
        decision: "approve",
        approved_text: "Edited and approved",
        selected_section_ids: ["1"],
        feedback_text: "",
        summary_model: {
          provider_id: "local-openai",
          model_id: "summary-model",
        },
      };
    },
  });

  const result = await tool.execute(
    "call",
    { queries: ["angle 0", "angle 1"] },
    new AbortController().signal,
    () => {},
  );

  assert.equal(reviewRequests.length, 2);
  assert.equal(reviewRequests[0].stage, "select-evidence");
  assert.equal(reviewRequests[0].draft_text, "");
  assert.equal(reviewRequests[1].stage, "review-summary");
  assert.equal(reviewRequests[1].draft_text, "Draft summary");
  assert.deepEqual(reviewRequests[1].summary_model, {
    provider_id: "local-openai",
    model_id: "summary-model",
  });
  assert.deepEqual(reviewRequests[1].draft_metadata.model, {
    provider_id: "openai",
    model_id: "test-model",
  });
  assert.equal(reviewRequests[1].draft_metadata.fallback_used, false);
  assert.deepEqual(requestedSummaryModels, [
    {
      provider_id: "local-openai",
      model_id: "summary-model",
    },
    undefined,
  ]);
  assert.equal(reviewRequests[1].sections.length, 2);
  assert.doesNotMatch(summaryPrompt, /angle 0/u);
  assert.match(summaryPrompt, /angle 1/u);
  assert.equal(result.content[0].text, "Edited and approved");
  assert.equal(result.details.selected_query_count, 1);
  const {
    duration_ms: durationMs,
    token_estimate: tokenEstimate,
    ...synthesis
  } = result.details.synthesis;
  assert.ok(durationMs >= 0);
  assert.equal(tokenEstimate, 4);
  assert.deepEqual(synthesis, {
    model: "openai/test-model",
    fallback_used: false,
    reviewed: true,
    edited: true,
  });
});

test("summary-review regenerates selected evidence with feedback", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: `Evidence for ${request.query}`,
        sources: [{
          title: request.query,
          url: `https://example.com/${request.query.slice(-1)}`,
          snippet: "Evidence",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "auto",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
  });
  const prompts = [];
  let reviewCount = 0;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model(prompt) {
      prompts.push(prompt);
      return {
        text: `Draft ${prompts.length}`,
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    async request_summary_review(request) {
      reviewCount += 1;
      if (request.stage === "select-evidence") {
        return {
          decision: "summarize",
          approved_text: "",
          selected_section_ids: ["0"],
          feedback_text: "",
          summary_model: null,
        };
      }
      if (reviewCount === 2) {
        return {
          decision: "regenerate",
          approved_text: request.draft_text,
          selected_section_ids: ["0"],
          feedback_text: "Emphasize the caveat.",
          summary_model: null,
        };
      }
      return {
        decision: "approve",
        approved_text: request.draft_text,
        selected_section_ids: ["0"],
        feedback_text: "",
        summary_model: null,
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "angle 0" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /<user_feedback>/u);
  assert.match(prompts[1], /Emphasize the caveat\./u);
  assert.equal(result.content[0].text, "Draft 2");
});

test("summary-review can return selected raw evidence without synthesis", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: `Evidence for ${request.query}`,
        sources: [{
          title: request.query,
          url: `https://example.com/${request.query.slice(-1)}`,
          snippet: "Evidence",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "auto",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
  });
  let completionCalled = false;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      completionCalled = true;
      throw new Error("must not run");
    },
    async request_summary_review() {
      return {
        decision: "raw",
        approved_text: "",
        selected_section_ids: ["1"],
        feedback_text: "",
        summary_model: null,
      };
    },
  });

  const result = await tool.execute(
    "call",
    { queries: ["angle 0", "angle 1"] },
    new AbortController().signal,
    () => {},
  );

  assert.equal(completionCalled, false);
  assert.doesNotMatch(result.content[0].text, /angle 0/u);
  assert.match(result.content[0].text, /angle 1/u);
  assert.equal(result.details.selected_query_count, 1);
  assert.equal(result.details.synthesis, undefined);
});

test("summary-review fails closed when the viewer boundary is unavailable", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Evidence",
        sources: [],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "auto",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /review is unavailable/u);
});
