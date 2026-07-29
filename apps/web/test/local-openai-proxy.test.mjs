import assert from "node:assert/strict";
import test from "node:test";
import { proxyLocalOpenAiRequest } from "../server/local-openai-proxy.ts";

test("local OpenAI proxy forwards only the configured models route", async () => {
  await withFetchStub(async (input, init) => {
    assert.equal(input, "http://127.0.0.1:4141/v1/models");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.headers.get("accept"), "application/json");
    return Response.json(
      { data: [{ id: "gpt-test" }] },
      {
        headers: { "x-request-id": "models-request" },
      },
    );
  }, async () => {
    const response = await proxyLocalOpenAiRequest(
      new Request("http://localhost/api/providers/local-openai/models", {
        headers: {
          accept: "application/json",
          authorization: "secret",
          "x-researchbox-provider": "local-openai",
        },
      }),
      "/models",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-request-id"), "models-request");
    assert.deepEqual(await response.json(), {
      data: [{ id: "gpt-test" }],
    });
  });
});

test("local OpenAI proxy preserves a streaming chat response", async () => {
  await withFetchStub(async (input, init) => {
    assert.equal(
      input,
      "http://127.0.0.1:4141/v1/chat/completions",
    );
    assert.equal(init.method, "POST");
    assert.equal(init.headers.get("content-type"), "application/json");
    assert.equal(await new Response(init.body).text(), '{"model":"gpt-test"}');
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("data: {\"choices\":[]}\n\n"),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      {
        status: 201,
        headers: { "content-type": "text/event-stream" },
      },
    );
  }, async () => {
    const response = await proxyLocalOpenAiRequest(
      new Request(
        "http://localhost/api/providers/local-openai/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-researchbox-provider": "local-openai",
          },
          body: '{"model":"gpt-test"}',
        },
      ),
      "/chat/completions",
    );
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(
      await response.text(),
      "data: {\"choices\":[]}\n\ndata: [DONE]\n\n",
    );
  });
});

test("local OpenAI proxy reports an unreachable gateway", async () => {
  await withFetchStub(async () => {
    throw new Error("connection refused");
  }, async () => {
    const response = await proxyLocalOpenAiRequest(
      new Request("http://localhost/api/providers/local-openai/models", {
        headers: { "x-researchbox-provider": "local-openai" },
      }),
      "/models",
    );
    assert.equal(response.status, 502);
    assert.match(
      (await response.json()).error_message,
      /connection refused/,
    );
  });
});

test("local OpenAI proxy rejects non-rrbox callers", async () => {
  await withFetchStub(async () => {
    throw new Error("fetch must not be called");
  }, async () => {
    const response = await proxyLocalOpenAiRequest(
      new Request("http://localhost/api/providers/local-openai/models", {
        headers: { origin: "https://example.com" },
      }),
      "/models",
    );
    assert.equal(response.status, 403);
  });
});

test("local OpenAI proxy rejects an oversized chat request before forwarding", async () => {
  let fetchCalled = false;
  await withFetchStub(async () => {
    fetchCalled = true;
    throw new Error("fetch must not be called");
  }, async () => {
    const response = await proxyLocalOpenAiRequest(
      new Request(
        "http://localhost/api/providers/local-openai/chat/completions",
        {
          method: "POST",
          headers: {
            "content-length": String(16 * 1024 * 1024 + 1),
            "content-type": "application/json",
            "x-researchbox-provider": "local-openai",
          },
          body: "{}",
        },
      ),
      "/chat/completions",
    );

    assert.equal(response.status, 413);
    assert.equal(fetchCalled, false);
    assert.deepEqual(await response.json(), {
      error_message: "The provider request body is too large.",
    });
  });
});

test("local OpenAI proxy forwards client aborts to the provider request", async () => {
  const requestController = new AbortController();
  let forwardedSignal;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });

  await withFetchStub(async (_input, init) => {
    forwardedSignal = init.signal;
    markFetchStarted();
    await new Promise((resolve, reject) => {
      if (forwardedSignal.aborted) {
        reject(forwardedSignal.reason);
        return;
      }
      forwardedSignal.addEventListener(
        "abort",
        () => reject(forwardedSignal.reason),
        { once: true },
      );
    });
  }, async () => {
    const pendingResponse = proxyLocalOpenAiRequest(
      new Request(
        "http://localhost/api/providers/local-openai/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-researchbox-provider": "local-openai",
          },
          body: "{}",
          signal: requestController.signal,
        },
      ),
      "/chat/completions",
    );
    await fetchStarted;

    requestController.abort(new DOMException("client disconnected", "AbortError"));
    const response = await pendingResponse;

    assert.equal(forwardedSignal.aborted, true);
    assert.equal(response.status, 502);
    assert.match(
      (await response.json()).error_message,
      /client disconnected/,
    );
  });
});

async function withFetchStub(fetchStub, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
