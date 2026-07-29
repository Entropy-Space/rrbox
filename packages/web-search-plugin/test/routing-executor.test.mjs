import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProviderError,
  RoutingWebSearchExecutor,
  WebSearchAggregateError,
  WebSearchProviderError,
} from "../src/routing-executor.ts";

const request = {
  query: "example",
  num_results: 5,
  include_content: false,
  provider: "auto",
};

test("routes auto searches through an explicit configured provider", async () => {
  const requests = [];
  let closed = false;
  const executor = new RoutingWebSearchExecutor({
    default_provider: "exa",
    providers: [
      provider("exa", async (received) => {
        requests.push(received);
        return response("exa", "answer");
      }, () => {
        closed = true;
      }),
    ],
  });

  const result = await executor.search(request);

  assert.deepEqual(executor.provider_ids, ["exa"]);
  assert.equal(result.provider, "exa");
  assert.equal(requests[0].provider, "exa");
  await executor.close();
  assert.equal(closed, true);
  await assert.rejects(executor.search(request), /closed/u);
});

test("auto routing skips unavailable providers and retries classified failures", async () => {
  const calls = [];
  const executor = new RoutingWebSearchExecutor({
    default_provider: "auto",
    providers: [
      {
        ...provider("exa", async () => {
          throw new Error("must not run");
        }),
        is_available() {
          calls.push("exa:available");
          return false;
        },
      },
      provider("anysearch", async (received) => {
        calls.push(`anysearch:${received.provider}`);
        return response("anysearch", "fallback answer");
      }),
    ],
    routing: {
      providers: ["exa", "anysearch"],
      fallback_on: ["transient", "quota", "network"],
    },
  });

  const result = await executor.search(request);

  assert.deepEqual(executor.provider_ids, ["exa", "anysearch"]);
  assert.equal(result.provider, "anysearch");
  assert.deepEqual(calls, [
    "exa:available",
    "anysearch:anysearch",
  ]);
});

test("reports available providers with their all-routing eligibility", async () => {
  const executor = new RoutingWebSearchExecutor({
    default_provider: "auto",
    providers: [
      provider("exa", async () => response("exa")),
      {
        ...provider("anysearch", async () => response("anysearch")),
        include_in_all: false,
      },
    ],
  });

  assert.deepEqual(await executor.list_available_providers(), [{
    provider_id: "exa",
    include_in_all: true,
  }, {
    provider_id: "anysearch",
    include_in_all: false,
  }]);
});

test("omits unavailable providers from review choices", async () => {
  const executor = new RoutingWebSearchExecutor({
    default_provider: "auto",
    providers: [{
      ...provider("exa", async () => response("exa")),
      is_available: () => false,
    }, {
      ...provider("anysearch", async () => response("anysearch")),
      include_in_all: false,
    }],
  });

  assert.deepEqual(await executor.list_available_providers(), [{
    provider_id: "anysearch",
    include_in_all: false,
  }]);
});

test("auto routing falls through transient errors but stops on permanent errors", async () => {
  const calls = [];
  const transientExecutor = new RoutingWebSearchExecutor({
    default_provider: "auto",
    providers: [
      provider("exa", async () => {
        calls.push("exa");
        throw new Error("HTTP 503 temporarily unavailable");
      }),
      provider("anysearch", async () => {
        calls.push("anysearch");
        return response("anysearch", "fallback");
      }),
    ],
    routing: {
      providers: ["exa", "anysearch"],
      fallback_on: ["transient"],
    },
  });

  assert.equal(
    (await transientExecutor.search(request)).provider,
    "anysearch",
  );
  assert.deepEqual(calls, ["exa", "anysearch"]);

  calls.length = 0;
  const permanentExecutor = new RoutingWebSearchExecutor({
    default_provider: "auto",
    providers: [
      provider("exa", async () => {
        calls.push("exa");
        throw new Error("HTTP 401 invalid API key");
      }),
      provider("anysearch", async () => {
        calls.push("anysearch");
        return response("anysearch", "must not run");
      }),
    ],
    routing: {
      providers: ["exa", "anysearch"],
      fallback_on: ["transient", "quota", "network"],
    },
  });

  await assert.rejects(
    permanentExecutor.search(request),
    (error) =>
      error instanceof WebSearchProviderError &&
      error.provider_id === "exa" &&
      error.kind === "permanent",
  );
  assert.deepEqual(calls, ["exa"]);
});

test("all routing merges successes, deduplicates URLs, and reports partial failures", async () => {
  const executor = new RoutingWebSearchExecutor({
    default_provider: "all",
    providers: [
      provider("exa", async () => ({
        ...response("exa", "Exa answer"),
        sources: [
          source("shared", "https://example.com/shared"),
          source("exa", "https://example.com/exa"),
        ],
      })),
      provider("anysearch", async () => {
        throw new Error("HTTP 429 quota exhausted");
      }),
    ],
    routing: {
      providers: ["exa", "anysearch"],
      fallback_on: ["transient", "quota", "network"],
    },
  });

  const result = await executor.search({
    ...request,
    provider: "all",
  });

  assert.equal(result.provider, "all");
  assert.match(result.answer, /## Exa/u);
  assert.match(result.answer, /Provider errors/u);
  assert.match(result.answer, /AnySearch/u);
  assert.deepEqual(
    result.sources.map((entry) => entry.url),
    [
      "https://example.com/shared",
      "https://example.com/exa",
    ],
  );
  assert.deepEqual(
    result.provider_responses.map((entry) => entry.provider),
    ["exa"],
  );
  assert.deepEqual(result.provider_errors, [{
    provider: "anysearch",
    error: "HTTP 429 quota exhausted",
  }]);
});

test("all routing combines providers in configured order and respects the result bound", async () => {
  const executor = new RoutingWebSearchExecutor({
    default_provider: "all",
    providers: [
      provider("exa", async () => ({
        ...response("exa", "Exa answer"),
        sources: [
          source("shared", "https://example.com/shared"),
          source("exa", "https://example.com/exa"),
        ],
      })),
      provider("anysearch", async () => ({
        ...response("anysearch", "AnySearch answer"),
        sources: [
          source("shared", "https://example.com/shared"),
          source("anysearch", "https://example.com/anysearch"),
        ],
      })),
    ],
  });

  const result = await executor.search({
    ...request,
    num_results: 2,
    provider: "all",
  });

  assert.match(result.answer, /## Exa[\s\S]*## AnySearch/u);
  assert.deepEqual(
    result.sources.map((entry) => entry.url),
    [
      "https://example.com/shared",
      "https://example.com/anysearch",
    ],
  );
  assert.deepEqual(
    result.provider_responses.map((entry) => entry.provider),
    ["exa", "anysearch"],
  );
  assert.deepEqual(result.provider_errors, []);
});

test("all routing excludes providers marked explicit-only", async () => {
  const calls = [];
  const executor = new RoutingWebSearchExecutor({
    default_provider: "all",
    providers: [
      provider("exa", async () => {
        calls.push("exa");
        return response("exa", "Exa answer");
      }),
      {
        ...provider("anysearch", async () => {
          calls.push("anysearch");
          return response("anysearch", "AnySearch answer");
        }),
        include_in_all: false,
      },
    ],
  });

  const result = await executor.search({
    ...request,
    provider: "all",
  });

  assert.deepEqual(calls, ["exa"]);
  assert.deepEqual(
    result.provider_responses.map((entry) => entry.provider),
    ["exa"],
  );
  assert.doesNotMatch(result.answer, /AnySearch/u);
});

test("all routing reports every provider failure", async () => {
  const executor = new RoutingWebSearchExecutor({
    default_provider: "all",
    providers: [
      provider("exa", async () => {
        throw new Error("network connection failed");
      }),
      provider("anysearch", async () => {
        throw new Error("HTTP 503 unavailable");
      }),
    ],
  });

  await assert.rejects(
    executor.search({ ...request, provider: "all" }),
    (error) =>
      error instanceof WebSearchAggregateError &&
      error.errors.length === 2 &&
      /All-provider/u.test(error.message),
  );
});

test("validates routing configuration and unavailable explicit providers", async () => {
  assert.throws(
    () =>
      new RoutingWebSearchExecutor({
        default_provider: "auto",
        providers: [],
      }),
    /At least one/u,
  );
  assert.throws(
    () =>
      new RoutingWebSearchExecutor({
        default_provider: "auto",
        providers: [provider("exa", async () => response("exa"))],
        routing: {
          providers: ["exa", "exa"],
          fallback_on: ["network"],
        },
      }),
    /Duplicate routed/u,
  );
  const executor = new RoutingWebSearchExecutor({
    default_provider: "anysearch",
    providers: [provider("exa", async () => response("exa"))],
  });
  await assert.rejects(executor.search(request), /unavailable: anysearch/u);
});

test("classifies provider failures for routing decisions", () => {
  assert.equal(
    classifyProviderError("exa", new Error("HTTP 429")).kind,
    "quota",
  );
  assert.equal(
    classifyProviderError("anysearch", new Error("API error 402")).kind,
    "quota",
  );
  assert.equal(
    classifyProviderError("exa", new Error("DNS lookup failed")).kind,
    "network",
  );
  assert.equal(
    classifyProviderError("exa", new Error("request timeout")).kind,
    "transient",
  );
  assert.equal(
    classifyProviderError("exa", new Error("HTTP 400")).kind,
    "permanent",
  );
});

test("close attempts every provider even when one fails", async () => {
  const closed = [];
  const executor = new RoutingWebSearchExecutor({
    default_provider: "auto",
    providers: [
      provider("exa", async () => response("exa"), () => {
        closed.push("exa");
        throw new Error("close failed");
      }),
      provider("anysearch", async () => response("anysearch"), () => {
        closed.push("anysearch");
      }),
    ],
  });

  await assert.rejects(executor.close(), WebSearchAggregateError);
  assert.deepEqual(closed, ["exa", "anysearch"]);
});

function provider(id, search, close = () => {}) {
  return { id, search, close };
}

function response(providerId, answer = "answer") {
  return {
    query: "example",
    provider: providerId,
    answer,
    sources: [],
  };
}

function source(title, url) {
  return { title, url, snippet: title };
}
