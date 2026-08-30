import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, {
  CallId,
  LlmAdapter,
} from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import DshrboxSummaryReview from "@dshrbox/summary-review";
import {
  DshrboxWebResearch,
} from "../src/dsh-web-research-plugin.ts";

const OPTIONS = {
  maximum_results: 7,
  maximum_output_bytes: 64 * 1024,
  default_provider: "auto",
  default_workflow: "auto-summary",
  summary_timeout_ms: 1_000,
  review_timeout_ms: 1_000,
};

class TextAdapter extends LlmAdapter {
  constructor(text) {
    super();
    this.text = text;
    this.requests = [];
  }

  async *stream(options) {
    this.requests.push(options);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: this.text };
    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text: this.text },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

test("registers native DSH web tools with canonical structured output", async () => {
  const searchCalls = [];
  let closed = false;
  const { context } = await createToolContext({
    async search(request) {
      searchCalls.push(request);
      return searchResponse(request.query);
    },
    close() {
      closed = true;
    },
  }, {
    async open(url, format, signal) {
      assert.equal(signal.aborted, false);
      return {
        requested_url: url,
        final_url: url,
        title: "Example page",
        content: `opened as ${format}`,
        content_type: "text/html",
        status: 200,
        source: "direct",
      };
    },
  });
  try {
    assert.deepEqual(
      context.tools.schemas().map((schema) => schema.name),
      ["web_search", "open_url"],
    );

    const search = await executeTool(context, "web_search", {
      query: "native dsh tools",
      workflow: "none",
    });
    assert.equal(search.isError, false);
    assert.deepEqual(searchCalls, [{
      query: "native dsh tools",
      num_results: 5,
      include_content: false,
      provider: "auto",
    }]);
    assert.match(search.value.content, /Example result/u);
    assert.deepEqual(search.meta, {
      summary: "Searched web for “native dsh tools”",
    });
    assert.deepEqual(search.content, [{
      type: "text",
      text: search.value.content,
    }]);

    const opened = await executeTool(context, "open_url", {
      url: "https://example.com/page",
    });
    assert.equal(opened.isError, false);
    assert.equal(opened.value.content, "opened as markdown");
    assert.equal(opened.value.details.output_bytes, 18);
    assert.deepEqual(opened.meta, {
      summary: "Opened Example page as MARKDOWN",
    });
  } finally {
    await context.fiber.dispose();
  }
  assert.equal(closed, false, "the application retains executor ownership");
});

test("uses the active DSH model for web synthesis", async () => {
  const adapter = new TextAdapter(
    "Native synthesis.\n\nSources\n- https://example.com/source",
  );
  const { context } = await createToolContext({
    async search(request) {
      return searchResponse(request.query);
    },
    close() {},
  }, undefined, adapter);
  try {
    const result = await executeTool(
      context,
      "web_search",
      { query: "DSH synthesis", workflow: "auto-summary" },
      createAgentScope(context),
    );
    assert.equal(result.isError, false, result.error?.message);
    assert.equal(result.value.content, adapter.text);
    assert.equal(result.value.details.synthesis.model, "test/test-model");
    assert.equal(adapter.requests.length, 1);
    assert.equal(adapter.requests[0].provider, "test");
    assert.equal(adapter.requests[0].model, "test-model");
    assert.deepEqual(adapter.requests[0].messages[0].source, {
      kind: "plugin",
      plugin: "web-search",
    });
    assert.equal(adapter.requests[0].tools, undefined);
  } finally {
    await context.fiber.dispose();
  }
});

test("routes summary review through the dshrbox interaction service", async () => {
  const { context, events } = await createToolContext({
    async search(request) {
      return searchResponse(request.query);
    },
    close() {},
  });
  context.dshrboxSummaryReview.beginRequest("request-1");
  try {
    const pending = executeTool(context, "web_search", {
      query: "review this evidence",
      workflow: "summary-review",
    });
    const review = await waitForReview(events);
    const approvesDraft = review.stage === "review-summary";
    context.dshrboxSummaryReview.resolve(review.interaction_id, {
      decision: approvesDraft ? "approve" : "raw",
      approved_text: approvesDraft ? review.draft_text : "",
      selected_section_ids: review.selected_section_ids,
      feedback_text: "",
      summary_model: null,
      search_provider: review.search_provider,
      query_text: "",
    });
    const result = await pending;
    assert.equal(result.isError, false, result.error?.message);
    assert.match(result.value.content, /Example result/u);
    assert.equal(result.value.details.synthesis.reviewed, true);
  } finally {
    context.dshrboxSummaryReview.endRequest();
    await context.fiber.dispose();
  }
});

async function createToolContext(executor, urlReader, adapter) {
  const events = [];
  const context = new Context();
  await context.plugin(LlmRuntime);
  if (adapter) context.llm.registerAdapter(["test"], adapter);
  await context.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
  });
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(DshrboxSummaryReview, {
    project_id: "project-1",
    session_id: "session-1",
    event_sink: (event) => events.push(event),
  });
  await context.plugin(DshrboxWebResearch, {
    ...OPTIONS,
    executor,
    ...(urlReader ? { url_reader: urlReader } : {}),
  });
  return { context, events };
}

function executeTool(context, name, args, agent) {
  return context.tools.execute({
    callId: CallId(`test-${name}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    ...(agent ? { agent } : {}),
  });
}

function createAgentScope(context) {
  return {
    id: "session-1",
    options: { provider: "test", model: "test-model" },
    ctx: context,
  };
}

function searchResponse(query) {
  return {
    query,
    provider: "exa",
    answer: "Example answer",
    sources: [{
      title: "Example result",
      url: "https://example.com/source",
      snippet: "Example evidence.",
    }],
  };
}

async function waitForReview(events) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = events.findLast(
      (candidate) =>
        candidate.type === "summary_review_updated" &&
        candidate.payload.is_loading === false,
    );
    if (event) return event.payload;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for summary review.");
}
