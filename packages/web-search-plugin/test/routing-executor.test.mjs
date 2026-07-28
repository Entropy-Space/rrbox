import assert from "node:assert/strict";
import test from "node:test";
import { RoutingWebSearchExecutor } from "../src/routing-executor.ts";

test("routes auto searches through the configured provider", async () => {
  const requests = [];
  let closed = false;
  const executor = new RoutingWebSearchExecutor({
    default_provider: "exa",
    providers: [{
      id: "exa",
      async search(request) {
        requests.push(request);
        return {
          query: request.query,
          provider: "exa",
          answer: "answer",
          sources: [],
        };
      },
      close() {
        closed = true;
      },
    }],
  });

  const response = await executor.search({
    query: "example",
    num_results: 5,
    include_content: false,
    provider: "auto",
  });

  assert.equal(response.provider, "exa");
  assert.equal(requests[0].provider, "exa");
  await executor.close();
  assert.equal(closed, true);
  await assert.rejects(
    executor.search({
      query: "example",
      num_results: 5,
      include_content: false,
      provider: "auto",
    }),
    /closed/u,
  );
});

test("rejects unavailable configured providers", () => {
  assert.throws(
    () =>
      new RoutingWebSearchExecutor({
        default_provider: "exa",
        providers: [],
      }),
    /At least one/u,
  );
});
