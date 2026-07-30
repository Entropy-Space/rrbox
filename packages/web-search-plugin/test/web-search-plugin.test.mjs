import assert from "node:assert/strict";
import test from "node:test";
import {
  WebSearchAggregateError,
  WebSearchProviderError,
} from "../src/routing-executor.ts";
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
    review_timeout_ms: 1_000,
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
  const progressUpdates = [];
  const result = await tool.execute(
    "call",
    {
      queries: ["Rust language", "Rust memory safety"],
      num_results: 3,
      recency_filter: "month",
      domain_filter: ["rust-lang.org", "-example.com"],
    },
    new AbortController().signal,
    (update) => progressUpdates.push(update),
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
  assert.deepEqual(
    progressUpdates.map((update) => ({
      summary: update.details.summary,
      progress: update.details.progress,
    })),
    [
      {
        summary: "Preparing 2 web searches…",
        progress: {
          phase: "searching",
          completed_queries: 0,
          total_queries: 2,
        },
      },
      {
        summary: "Searching 1/2…",
        progress: {
          phase: "searching",
          completed_queries: 1,
          total_queries: 2,
        },
      },
      {
        summary: "Searching 2/2…",
        progress: {
          phase: "searching",
          completed_queries: 2,
          total_queries: 2,
        },
      },
      {
        summary: "Summarizing…",
        progress: {
          phase: "generating-summary",
          completed_queries: 2,
          total_queries: 2,
        },
      },
    ],
  );
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

test("automatic summary keeps all-provider evidence separated", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "all",
        answer: "Combined provider answer",
        sources: [{
          title: "Shared",
          url: "https://example.com/shared",
        }],
        provider_responses: [{
          query: request.query,
          provider: "exa",
          answer: "Exa evidence",
          sources: [{
            title: "Shared",
            url: "https://example.com/shared",
          }],
        }, {
          query: request.query,
          provider: "anysearch",
          answer: "AnySearch evidence",
          sources: [{
            title: "AnySearch",
            url: "https://example.com/anysearch",
          }],
        }],
        provider_errors: [],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "all",
    default_workflow: "auto-summary",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  let summaryPrompt = "";
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model(prompt) {
      summaryPrompt = prompt;
      return {
        text: "Attributed summary",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example", provider: "all" },
    new AbortController().signal,
    () => {},
  );

  assert.match(summaryPrompt, /Provider: exa/u);
  assert.match(summaryPrompt, /Exa evidence/u);
  assert.match(summaryPrompt, /Provider: anysearch/u);
  assert.match(summaryPrompt, /AnySearch evidence/u);
  assert.doesNotMatch(summaryPrompt, /Combined provider answer/u);
  assert.equal(result.details.selected_query_count, 1);
  assert.equal(result.details.successful_queries, 1);
  assert.equal(result.details.total_results, 2);
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
    review_timeout_ms: 1_000,
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

test("treats an empty summary completion as a deterministic fallback", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Bounded factual evidence.",
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
    review_timeout_ms: 1_000,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      return {
        text: " \n ",
        provider_id: "openai",
        model_id: "empty-model",
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.match(result.content[0].text, /Bounded factual evidence/u);
  assert.equal(result.details.synthesis.fallback_used, true);
  assert.equal(
    result.details.synthesis.fallback_reason,
    "summary-model-empty-response",
  );
});

test("summary review deadline returns a deterministic synthesis", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Evidence retained after idle review.",
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
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 10,
  });
  let reviewAborted = false;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      throw new Error("Selection timeout must not call the model.");
    },
    async request_summary_review(_request, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reviewAborted = true;
          reject(new DOMException("Review timed out.", "AbortError"));
        }, { once: true });
      });
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(reviewAborted, true);
  assert.match(
    result.content[0].text,
    /Evidence retained after idle review/u,
  );
  assert.equal(result.details.synthesis.fallback_used, true);
  assert.equal(
    result.details.synthesis.fallback_reason,
    "summary-review-timeout",
  );
  assert.equal(result.details.synthesis.reviewed, true);
});

test("active review interaction resets the idle deadline", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Evidence retained during active review.",
        sources: [{
          title: "Example",
          url: "https://example.com/",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 60,
  });
  let draftRequest;
  let resolveReview;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    open_summary_review() {
      const activityTimers = [];
      return {
        resolution: new Promise((resolve) => {
          resolveReview = resolve;
        }),
        subscribe_activity(listener) {
          activityTimers.push(setTimeout(listener, 40));
          activityTimers.push(setTimeout(() => {
            resolveReview({
              decision: "approve",
              approved_text: draftRequest.draft_text,
              selected_section_ids:
                draftRequest.selected_section_ids,
              feedback_text: "",
              summary_model: null,
              search_provider: "exa",
              query_text: "",
            });
          }, 80));
          return () => {
            for (const timer of activityTimers) clearTimeout(timer);
          };
        },
        update(request) {
          if (request.stage === "review-summary") {
            draftRequest = request;
          }
        },
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.match(
    result.content[0].text,
    /Evidence retained during active review/u,
  );
  assert.equal(
    result.details.synthesis.fallback_reason,
    "model-completion-unavailable",
  );
});

test("hiding during search continues with tool-card progress", async () => {
  const updates = [];
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        query: request.query,
        provider: "exa",
        answer: "Background evidence.",
        sources: [{
          title: "Example",
          url: "https://example.com/",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
    summary_grace_ms: 1_000,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      return {
        text: "Background summary.",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    open_summary_review(_request, signal) {
      return {
        resolution: new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("Review closed."));
          }, { once: true });
        }),
        is_visible() {
          return false;
        },
        subscribe_activity() {
          return () => undefined;
        },
        subscribe_visibility() {
          return () => undefined;
        },
        update() {},
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    (update) => updates.push(update.details.summary),
  );

  assert.equal(result.content[0].text, "Background summary.");
  assert.ok(updates.includes("Searching 1/1…"));
  assert.ok(updates.includes("Summarizing…"));
});

test("hiding during summarization submits as soon as it finishes", async () => {
  let isVisible = true;
  const visibilityListeners = new Set();
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Summary evidence.",
        sources: [{
          title: "Example",
          url: "https://example.com/",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
    summary_grace_ms: 0,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        text: "Finished background summary.",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    open_summary_review(_request, signal) {
      return {
        resolution: new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("Review closed."));
          }, { once: true });
        }),
        is_visible() {
          return isVisible;
        },
        subscribe_activity() {
          return () => undefined;
        },
        subscribe_visibility(listener) {
          visibilityListeners.add(listener);
          return () => visibilityListeners.delete(listener);
        },
        update(request) {
          if (request.loading_phase === "summary") {
            isVisible = false;
            for (const listener of visibilityListeners) listener(false);
          }
        },
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(result.content[0].text, "Finished background summary.");
  assert.equal(result.details.synthesis.fallback_used, false);
});

test("reopening during summarization restores summary review", async () => {
  let isVisible = true;
  const visibilityListeners = new Set();
  let resolveReview;
  const reviewUpdates = [];
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Reopened evidence.",
        sources: [{
          title: "Example",
          url: "https://example.com/",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
    summary_grace_ms: 0,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      isVisible = true;
      for (const listener of visibilityListeners) listener(true);
      return {
        text: "Reopened draft summary.",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    open_summary_review(_request, signal) {
      return {
        resolution: new Promise((resolve, reject) => {
          resolveReview = resolve;
          signal.addEventListener("abort", () => {
            reject(new Error("Review closed."));
          }, { once: true });
        }),
        is_visible() {
          return isVisible;
        },
        subscribe_activity() {
          return () => undefined;
        },
        subscribe_visibility(listener) {
          visibilityListeners.add(listener);
          return () => visibilityListeners.delete(listener);
        },
        update(request) {
          reviewUpdates.push(request);
          if (request.loading_phase === "summary") {
            isVisible = false;
            for (const listener of visibilityListeners) listener(false);
          }
          if (request.stage === "review-summary") {
            resolveReview({
              decision: "approve",
              approved_text: "Approved after reopening.",
              selected_section_ids: request.selected_section_ids,
              feedback_text: "",
              summary_model: request.summary_model,
              search_provider: request.search_provider,
              query_text: "",
            });
          }
        },
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.ok(
    reviewUpdates.some((request) => request.stage === "review-summary"),
  );
  assert.equal(result.content[0].text, "Approved after reopening.");
});

test("summary grace keeps the dialog open before generation", async () => {
  const phases = [];
  const graceNotices = [];
  let resolveReview;
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Grace-period evidence.",
        sources: [{
          title: "Example",
          url: "https://example.com/",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
    summary_grace_ms: 1_200,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      return {
        text: "Grace-period summary.",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    open_summary_review(initialRequest) {
      phases.push(initialRequest.loading_phase);
      graceNotices.push(initialRequest.query_notice);
      return {
        resolution: new Promise((resolve) => {
          resolveReview = resolve;
        }),
        subscribe_activity() {
          return () => undefined;
        },
        update(request) {
          phases.push(request.loading_phase);
          if (request.loading_phase === "summary-grace") {
            graceNotices.push(request.query_notice);
          }
          if (request.stage === "review-summary") {
            resolveReview({
              decision: "approve",
              approved_text: request.draft_text,
              selected_section_ids: request.selected_section_ids,
              feedback_text: "",
              summary_model: null,
              search_provider: "exa",
              query_text: "",
            });
          }
        },
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(result.content[0].text, "Grace-period summary.");
  assert.ok(phases.includes("summary-grace"));
  assert.ok(phases.includes("summary"));
  assert.ok(graceNotices.some((notice) => /2 seconds/u.test(notice ?? "")));
  assert.ok(graceNotices.some((notice) => /1 seconds/u.test(notice ?? "")));
});

test("opens a search placeholder before provider discovery completes", async () => {
  let releaseProviders;
  const providersReady = new Promise((resolve) => {
    releaseProviders = resolve;
  });
  let initialRequest;
  let resolveReview;
  const plugin = createWebSearchAgentPlugin({
    async list_available_providers() {
      return providersReady;
    },
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Placeholder evidence.",
        sources: [{
          title: "Example",
          url: "https://example.com/",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
    summary_grace_ms: 0,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      return {
        text: "Placeholder summary.",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    open_summary_review(request) {
      initialRequest = request;
      return {
        resolution: new Promise((resolve) => {
          resolveReview = resolve;
        }),
        subscribe_activity() {
          return () => undefined;
        },
        update(request) {
          if (request.stage !== "review-summary") return;
          resolveReview({
            decision: "approve",
            approved_text: request.draft_text,
            selected_section_ids: request.selected_section_ids,
            feedback_text: "",
            summary_model: null,
            search_provider: "exa",
            query_text: "",
          });
        },
      };
    },
  });

  const execution = tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(initialRequest.loading_phase, "search");
  assert.equal(initialRequest.sections.length, 0);
  assert.match(initialRequest.query_notice, /Searching 0 of 1/u);

  releaseProviders([{ provider_id: "exa", include_in_all: true }]);
  const result = await execution;
  assert.equal(result.content[0].text, "Placeholder summary.");
});

test("summary draft deadline auto-submits the generated draft", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Evidence retained after draft timeout.",
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
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 10,
  });
  let reviewCount = 0;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      return {
        text: "Unapproved model draft",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    async request_summary_review(request, signal) {
      reviewCount += 1;
      if (request.stage === "select-evidence") {
        return {
          decision: "summarize",
          approved_text: "",
          selected_section_ids: ["0"],
          feedback_text: "",
          summary_model: null,
          query_text: "",
        };
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("Review timed out.", "AbortError"));
        }, { once: true });
      });
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(reviewCount, 2);
  assert.equal(result.content[0].text, "Unapproved model draft");
  assert.equal(result.details.synthesis.fallback_used, false);
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
    review_timeout_ms: 1_000,
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
      if (model) {
        return {
          text: "",
          provider_id: model.provider_id,
          model_id: model.model_id,
        };
      }
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
          query_text: "",
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
        query_text: "",
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

test("summary-review streams initial searches into one open review", async () => {
  const searchedQueries = [];
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      searchedQueries.push(request.query);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        query: request.query,
        provider: "exa",
        answer: `Evidence for ${request.query}`,
        sources: [{
          title: request.query,
          url: `https://example.com/${searchedQueries.length}`,
          snippet: "Evidence",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1,
  });
  const selectionUpdates = [];
  let selectionOpenCount = 0;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      return {
        text: "Live review summary",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    open_summary_review(request) {
      if (request.stage === "review-summary") {
        return {
          resolution: Promise.resolve({
            decision: "approve",
            approved_text: request.draft_text,
            selected_section_ids: request.selected_section_ids,
            feedback_text: "",
            summary_model: null,
            query_text: "",
          }),
          update() {
            throw new Error("Draft review should not be updated.");
          },
        };
      }
      selectionOpenCount += 1;
      assert.equal(searchedQueries.length, 0);
      assert.equal(request.is_loading, true);
      assert.deepEqual(request.sections, []);
      let resolveSelection;
      return {
        resolution: new Promise((resolve) => {
          resolveSelection = resolve;
        }),
        update(updatedRequest) {
          selectionUpdates.push(structuredClone(updatedRequest));
          if (updatedRequest.stage === "review-summary") {
            resolveSelection({
              decision: "approve",
              approved_text: updatedRequest.draft_text,
              selected_section_ids:
                updatedRequest.selected_section_ids,
              feedback_text: "",
              summary_model: null,
              query_text: "",
            });
          }
        },
      };
    },
  });

  const result = await tool.execute(
    "call",
    { queries: ["angle one", "angle two"] },
    new AbortController().signal,
    () => {},
  );

  assert.equal(selectionOpenCount, 1);
  assert.deepEqual(
    selectionUpdates.map((request) => ({
      stage: request.stage,
      is_loading: request.is_loading,
      loading_phase: request.loading_phase,
      section_count: request.sections.length,
      selected_section_ids: request.selected_section_ids,
    })),
    [{
      stage: "select-evidence",
      is_loading: true,
      loading_phase: "search",
      section_count: 0,
      selected_section_ids: [],
    }, {
      stage: "select-evidence",
      is_loading: true,
      loading_phase: "search",
      section_count: 1,
      selected_section_ids: ["0"],
    }, {
      stage: "select-evidence",
      is_loading: true,
      loading_phase: "search",
      section_count: 2,
      selected_section_ids: ["0", "1"],
    }, {
      stage: "select-evidence",
      is_loading: true,
      loading_phase: "summary",
      section_count: 2,
      selected_section_ids: ["0", "1"],
    }, {
      stage: "review-summary",
      is_loading: false,
      loading_phase: null,
      section_count: 2,
      selected_section_ids: ["0", "1"],
    }],
  );
  assert.equal(result.content[0].text, "Live review summary");
});

test("cancelling a loading review aborts its active search", async () => {
  let searchAborted = false;
  const plugin = createWebSearchAgentPlugin({
    async search(_request, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          searchAborted = true;
          reject(new DOMException("Cancelled", "AbortError"));
        }, { once: true });
      });
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    open_summary_review() {
      return {
        resolution: Promise.resolve({
          decision: "cancel",
          approved_text: "",
          selected_section_ids: [],
          feedback_text: "",
          summary_model: null,
          query_text: "",
        }),
        update() {},
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "cancel me" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(searchAborted, true);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cancelled by the user/u);
});

test("switching provider supersedes an active search", async () => {
  const calls = [];
  let initialSearchAborted = false;
  const plugin = createWebSearchAgentPlugin({
    provider_ids: ["exa", "anysearch"],
    async search(request, signal) {
      calls.push(request.provider);
      if (request.provider === "exa") {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            initialSearchAborted = true;
            reject(new DOMException("Superseded", "AbortError"));
          }, { once: true });
        });
      }
      return {
        query: request.query,
        provider: "anysearch",
        answer: "AnySearch evidence",
        sources: [{
          title: "AnySearch",
          url: "https://example.com/anysearch",
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  let reviewCount = 0;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    open_summary_review(request) {
      reviewCount += 1;
      if (reviewCount === 1) {
        assert.equal(request.loading_phase, "search");
        return {
          resolution: Promise.resolve({
            decision: "change-provider",
            approved_text: "",
            selected_section_ids: [],
            feedback_text: "",
            summary_model: null,
            search_provider: "anysearch",
            query_text: "",
          }),
          update() {},
        };
      }
      assert.equal(request.loading_phase, null);
      assert.equal(request.search_provider, "anysearch");
      assert.deepEqual(
        request.sections.map((section) => section.title),
        ["example · AnySearch"],
      );
      return {
        resolution: Promise.resolve({
          decision: "raw",
          approved_text: "",
          selected_section_ids: ["0"],
          feedback_text: "",
          summary_model: null,
          search_provider: "anysearch",
          query_text: "",
        }),
        update() {},
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example", provider: "exa" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(initialSearchAborted, true);
  assert.deepEqual(calls, ["exa", "anysearch"]);
  assert.match(result.content[0].text, /AnySearch evidence/u);
});

test("adding a search supersedes initial summary generation", async () => {
  const searchQueries = [];
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      searchQueries.push(request.query);
      return {
        query: request.query,
        provider: "exa",
        answer: `Evidence for ${request.query}`,
        sources: [{
          title: request.query,
          url: `https://example.com/${searchQueries.length}`,
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  let completionCount = 0;
  let initialGenerationAborted = false;
  let reviewCount = 0;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model(_prompt, signal) {
      completionCount += 1;
      if (completionCount === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            initialGenerationAborted = true;
            reject(new DOMException("Superseded", "AbortError"));
          }, { once: true });
        });
      }
      return {
        text: "Updated summary",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    open_summary_review(request) {
      reviewCount += 1;
      if (reviewCount === 1) {
        let resolveReview;
        return {
          resolution: new Promise((resolve) => {
            resolveReview = resolve;
          }),
          update(updatedRequest) {
            if (updatedRequest.loading_phase !== "summary") return;
            resolveReview({
              decision: "add-search",
              approved_text: "",
              selected_section_ids:
                updatedRequest.selected_section_ids,
              feedback_text: "",
              summary_model: null,
              search_provider: "exa",
              query_text: "second angle",
            });
          },
        };
      }
      if (reviewCount === 2) {
        assert.equal(request.stage, "select-evidence");
        assert.equal(request.loading_phase, null);
        assert.deepEqual(
          request.sections.map((section) => section.title),
          ["first angle · Exa", "second angle · Exa"],
        );
        return {
          resolution: Promise.resolve({
            decision: "summarize",
            approved_text: "",
            selected_section_ids: ["0", "1"],
            feedback_text: "",
            summary_model: null,
            search_provider: "exa",
            query_text: "",
          }),
          update() {},
        };
      }
      assert.equal(request.stage, "review-summary");
      assert.equal(request.draft_text, "Updated summary");
      return {
        resolution: Promise.resolve({
          decision: "approve",
          approved_text: request.draft_text,
          selected_section_ids: ["0", "1"],
          feedback_text: "",
          summary_model: null,
          search_provider: "exa",
          query_text: "",
        }),
        update() {},
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "first angle", provider: "exa" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(initialGenerationAborted, true);
  assert.equal(completionCount, 2);
  assert.deepEqual(searchQueries, ["first angle", "second angle"]);
  assert.equal(result.content[0].text, "Updated summary");
});

test("automatic draft can return to selection and regenerate", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      return {
        query: request.query,
        provider: "exa",
        answer: "Evidence",
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
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  let completionCount = 0;
  let reviewCount = 0;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model() {
      completionCount += 1;
      return {
        text: `Draft ${completionCount}`,
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    open_summary_review(request) {
      reviewCount += 1;
      if (reviewCount === 1) {
        let resolveInitialReview;
        return {
          resolution: new Promise((resolve) => {
            resolveInitialReview = resolve;
          }),
          update(updatedRequest) {
            if (updatedRequest.stage !== "review-summary") return;
            assert.equal(updatedRequest.draft_text, "Draft 1");
            resolveInitialReview({
              decision: "back",
              approved_text: "",
              selected_section_ids:
                updatedRequest.selected_section_ids,
              feedback_text: "",
              summary_model: null,
              query_text: "",
            });
          },
        };
      }
      if (reviewCount === 2) {
        assert.equal(request.stage, "select-evidence");
        return {
          resolution: Promise.resolve({
            decision: "summarize",
            approved_text: "",
            selected_section_ids: ["0"],
            feedback_text: "",
            summary_model: null,
            query_text: "",
          }),
          update() {},
        };
      }
      assert.equal(request.stage, "review-summary");
      assert.equal(request.draft_text, "Draft 2");
      return {
        resolution: Promise.resolve({
          decision: "approve",
          approved_text: request.draft_text,
          selected_section_ids: ["0"],
          feedback_text: "",
          summary_model: null,
          query_text: "",
        }),
        update() {},
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(reviewCount, 3);
  assert.equal(completionCount, 2);
  assert.equal(result.content[0].text, "Draft 2");
});

test("all-provider review keeps provider evidence independently selectable", async () => {
  const exaResponse = {
    query: "example",
    provider: "exa",
    answer: "Exa evidence",
    sources: [{
      title: "Exa source",
      url: "https://example.com/exa",
      snippet: "Exa",
    }],
  };
  const anySearchResponse = {
    query: "example",
    provider: "anysearch",
    answer: "AnySearch evidence",
    sources: [{
      title: "AnySearch source",
      url: "https://example.com/anysearch",
      snippet: "AnySearch",
    }],
  };
  const plugin = createWebSearchAgentPlugin({
    async search() {
      return {
        query: "example",
        provider: "all",
        answer: "Combined provider answer",
        sources: [
          ...exaResponse.sources,
          ...anySearchResponse.sources,
        ],
        provider_responses: [exaResponse, anySearchResponse],
        provider_errors: [],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "all",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  let summaryPrompt = "";
  let reviewCount = 0;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model(prompt) {
      summaryPrompt = prompt;
      return {
        text: "Selected provider summary",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    async request_summary_review(request) {
      reviewCount += 1;
      if (request.stage === "select-evidence") {
        assert.deepEqual(
          request.sections.map((section) => ({
            title: section.title,
            is_selectable: section.is_selectable,
          })),
          [
            { title: "example · Exa", is_selectable: true },
            { title: "example · AnySearch", is_selectable: true },
          ],
        );
        assert.deepEqual(request.selected_section_ids, ["0", "1"]);
        return {
          decision: "summarize",
          approved_text: "",
          selected_section_ids: ["1"],
          feedback_text: "",
          summary_model: null,
          query_text: "",
        };
      }
      return {
        decision: "approve",
        approved_text: request.draft_text,
        selected_section_ids: ["1"],
        feedback_text: "",
        summary_model: null,
        query_text: "",
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example", provider: "all" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(reviewCount, 2);
  assert.doesNotMatch(summaryPrompt, /Exa evidence/u);
  assert.match(summaryPrompt, /AnySearch evidence/u);
  assert.equal(result.details.selected_query_count, 1);
  assert.equal(result.details.successful_queries, 1);
  assert.equal(result.details.total_results, 1);
});

test("summary review can add evidence from another search provider", async () => {
  const calls = [];
  const plugin = createWebSearchAgentPlugin({
    provider_ids: ["exa", "anysearch"],
    async list_available_providers() {
      return [{
        provider_id: "exa",
        include_in_all: true,
      }, {
        provider_id: "anysearch",
        include_in_all: false,
      }];
    },
    async search(request) {
      calls.push({
        query: request.query,
        provider: request.provider,
      });
      return {
        query: request.query,
        provider: request.provider,
        answer: `${request.provider} evidence`,
        sources: [{
          title: `${request.provider} source`,
          url: `https://example.com/${request.provider}`,
        }],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "exa",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  let reviewCount = 0;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async request_summary_review(request) {
      reviewCount += 1;
      assert.deepEqual(request.search_providers, [{
        provider_id: "auto",
        display_name: "Automatic",
      }, {
        provider_id: "all",
        display_name: "All eligible",
      }, {
        provider_id: "exa",
        display_name: "Exa",
      }, {
        provider_id: "anysearch",
        display_name: "AnySearch",
      }]);
      if (reviewCount === 1) {
        assert.equal(request.search_provider, "exa");
        assert.deepEqual(
          request.sections.map((section) => section.title),
          ["example · Exa"],
        );
        return {
          decision: "change-provider",
          approved_text: "",
          selected_section_ids: ["0"],
          feedback_text: "",
          summary_model: null,
          search_provider: "anysearch",
          query_text: "",
        };
      }
      assert.equal(request.search_provider, "anysearch");
      assert.deepEqual(
        request.sections.map((section) => section.title),
        ["example · Exa", "example · AnySearch"],
      );
      assert.deepEqual(request.selected_section_ids, ["0", "1"]);
      assert.match(request.query_notice, /evidence added and selected/u);
      return {
        decision: "raw",
        approved_text: "",
        selected_section_ids: ["0", "1"],
        feedback_text: "",
        summary_model: null,
        search_provider: "anysearch",
        query_text: "",
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example", provider: "exa" },
    new AbortController().signal,
    () => {},
  );

  assert.deepEqual(calls, [{
    query: "example",
    provider: "exa",
  }, {
    query: "example",
    provider: "anysearch",
  }]);
  assert.equal(reviewCount, 2);
  assert.match(result.content[0].text, /## Query: example · Exa/u);
  assert.match(result.content[0].text, /## Query: example · AnySearch/u);
  assert.equal(result.details.selected_query_count, 1);
  assert.equal(result.details.total_results, 2);
});

test("all-provider review preserves each provider failure", async () => {
  const plugin = createWebSearchAgentPlugin({
    async search() {
      throw new WebSearchAggregateError([
        new WebSearchProviderError({
          provider_id: "exa",
          kind: "quota",
          message: "Exa quota exhausted.",
        }),
        new WebSearchProviderError({
          provider_id: "anysearch",
          kind: "network",
          message: "AnySearch network unavailable.",
        }),
      ], "All-provider web search failed.");
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "all",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async request_summary_review(request) {
      assert.deepEqual(
        request.sections.map((section) => ({
          title: section.title,
          body: section.body,
          is_selectable: section.is_selectable,
        })),
        [{
          title: "example · Exa",
          body: "Exa quota exhausted.",
          is_selectable: false,
        }, {
          title: "example · AnySearch",
          body: "AnySearch network unavailable.",
          is_selectable: false,
        }],
      );
      assert.deepEqual(request.selected_section_ids, []);
      return {
        decision: "cancel",
        approved_text: "",
        selected_section_ids: [],
        feedback_text: "",
        summary_model: null,
        query_text: "",
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "example", provider: "all" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cancelled by the user/u);
});

test("all-provider review bounds added evidence cards", async () => {
  let searchCount = 0;
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      searchCount += 1;
      const exaUrl = `https://example.com/exa-${searchCount}`;
      const anySearchUrl =
        `https://example.com/anysearch-${searchCount}`;
      return {
        query: request.query,
        provider: "all",
        answer: "Combined",
        sources: [
          { title: "Exa", url: exaUrl, snippet: "Exa" },
          {
            title: "AnySearch",
            url: anySearchUrl,
            snippet: "AnySearch",
          },
        ],
        provider_responses: [{
          query: request.query,
          provider: "exa",
          answer: "Exa evidence",
          sources: [{
            title: "Exa",
            url: exaUrl,
            snippet: "Exa",
          }],
        }, {
          query: request.query,
          provider: "anysearch",
          answer: "AnySearch evidence",
          sources: [{
            title: "AnySearch",
            url: anySearchUrl,
            snippet: "AnySearch",
          }],
        }],
        provider_errors: [],
      };
    },
    close() {},
  }, {
    maximum_results: 5,
    maximum_output_bytes: 64 * 1024,
    default_provider: "all",
    default_workflow: "summary-review",
    summary_timeout_ms: 1_000,
    review_timeout_ms: 1_000,
  });
  let attemptedAtLimit = false;
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async request_summary_review(request) {
      if (request.sections.length < 20) {
        return {
          decision: "add-search",
          approved_text: "",
          selected_section_ids: request.selected_section_ids,
          feedback_text: "",
          summary_model: null,
          query_text: `additional angle ${request.sections.length}`,
        };
      }
      if (!attemptedAtLimit) {
        attemptedAtLimit = true;
        return {
          decision: "add-search",
          approved_text: "",
          selected_section_ids: request.selected_section_ids,
          feedback_text: "",
          summary_model: null,
          query_text: "one search too many",
        };
      }
      assert.equal(request.sections.length, 20);
      assert.match(request.query_notice, /at most 20 evidence cards/u);
      return {
        decision: "raw",
        approved_text: "",
        selected_section_ids: ["0"],
        feedback_text: "",
        summary_model: null,
        query_text: "",
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "initial", provider: "all" },
    new AbortController().signal,
    () => {},
  );

  assert.equal(searchCount, 10);
  assert.equal(result.details.query_count, 10);
  assert.equal(result.details.selected_query_count, 1);
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
    review_timeout_ms: 1_000,
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
          query_text: "",
        };
      }
      if (reviewCount === 2) {
        return {
          decision: "regenerate",
          approved_text: request.draft_text,
          selected_section_ids: ["0"],
          feedback_text: "Emphasize the caveat.",
          summary_model: null,
          query_text: "",
        };
      }
      return {
        decision: "approve",
        approved_text: request.draft_text,
        selected_section_ids: ["0"],
        feedback_text: "",
        summary_model: null,
        query_text: "",
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

test("summary-review rewrites and adds another bounded search", async () => {
  const searchedQueries = [];
  const plugin = createWebSearchAgentPlugin({
    async search(request) {
      searchedQueries.push(request.query);
      return {
        query: request.query,
        provider: "exa",
        answer: `Evidence for ${request.query}`,
        sources: [{
          title: request.query,
          url: `https://example.com/${searchedQueries.length}`,
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
    review_timeout_ms: 1_000,
  });
  const reviewRequests = [];
  const modelPrompts = [];
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
    async complete_model(prompt) {
      modelPrompts.push(prompt);
      return {
        text: prompt.includes("Rewrite the following")
          ? '"refined research angle"'
          : "Combined summary",
        provider_id: "openai",
        model_id: "test-model",
      };
    },
    async request_summary_review(request) {
      reviewRequests.push(request);
      if (reviewRequests.length === 1) {
        return {
          decision: "rewrite-query",
          approved_text: "",
          selected_section_ids: ["0"],
          feedback_text: "",
          summary_model: null,
          query_text: "rough angle",
        };
      }
      if (reviewRequests.length === 2) {
        assert.equal(request.query_draft, "refined research angle");
        assert.match(request.query_notice, /improved/u);
        return {
          decision: "add-search",
          approved_text: "",
          selected_section_ids: ["0"],
          feedback_text: "",
          summary_model: null,
          query_text: request.query_draft,
        };
      }
      if (request.stage === "select-evidence") {
        assert.equal(request.sections.length, 2);
        assert.deepEqual(request.selected_section_ids, ["0", "1"]);
        return {
          decision: "summarize",
          approved_text: "",
          selected_section_ids: ["0", "1"],
          feedback_text: "",
          summary_model: null,
          query_text: "",
        };
      }
      return {
        decision: "approve",
        approved_text: request.draft_text,
        selected_section_ids: ["0", "1"],
        feedback_text: "",
        summary_model: null,
        query_text: "",
      };
    },
  });

  const result = await tool.execute(
    "call",
    { query: "initial angle" },
    new AbortController().signal,
    () => {},
  );

  assert.deepEqual(searchedQueries, [
    "initial angle",
    "refined research angle",
  ]);
  assert.equal(modelPrompts.length, 2);
  assert.match(modelPrompts[0], /Do not answer the query/u);
  assert.equal(result.content[0].text, "Combined summary");
  assert.equal(result.details.query_count, 2);
  assert.equal(result.details.selected_query_count, 2);
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
    review_timeout_ms: 1_000,
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
        query_text: "",
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
    review_timeout_ms: 1_000,
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
