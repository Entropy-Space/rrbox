import assert from "node:assert/strict";
import test from "node:test";
import { NativeAnySearchWebSearchProvider } from "../src/native-anysearch-provider.ts";
import {
  NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
  parseNativeWebSearchRequest,
} from "../src/native-protocol.ts";

test("searches AnySearch over the native port", async () => {
  const channel = new MessageChannel();
  channel.port2.onmessage = (event) => {
    const request = parseNativeWebSearchRequest(event.data);
    assert.equal(request.kind, "web_search_execute");
    assert.equal(request.provider_id, "anysearch");
    channel.port2.postMessage({
      protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
      request_id: request.request_id,
      operation_id: request.operation_id,
      kind: "web_search_execute_result",
      success: true,
      response: {
        query: request.query,
        provider: "anysearch",
        answer: "Answer",
        sources: [],
      },
    });
  };
  const provider = new NativeAnySearchWebSearchProvider(
    channel.port1,
    { timeout_ms: 20_000 },
  );

  assert.equal(provider.include_in_all, false);
  const result = await provider.search({
    query: "rust wasm",
    num_results: 5,
    include_content: false,
    provider: "anysearch",
  });

  assert.equal(result.provider, "anysearch");
  assert.equal(result.answer, "Answer");
  provider.close();
  channel.port2.close();
});

test("cancels native AnySearch when the caller aborts", async () => {
  const channel = new MessageChannel();
  let executeRequest;
  let cancelRequest;
  channel.port2.onmessage = (event) => {
    const request = parseNativeWebSearchRequest(event.data);
    if (request.kind === "web_search_execute") {
      executeRequest = request;
      return;
    }
    cancelRequest = request;
    channel.port2.postMessage({
      protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
      request_id: request.request_id,
      operation_id: request.operation_id,
      kind: "web_search_cancel_result",
      cancelled: true,
    });
    channel.port2.postMessage({
      protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
      request_id: executeRequest.request_id,
      operation_id: executeRequest.operation_id,
      kind: "web_search_execute_result",
      success: false,
      code: "aborted",
      message: "Web search was cancelled.",
    });
  };
  const provider = new NativeAnySearchWebSearchProvider(
    channel.port1,
    { timeout_ms: 20_000 },
  );
  const controller = new AbortController();
  const search = provider.search({
    query: "rust wasm",
    num_results: 5,
    include_content: false,
    provider: "anysearch",
  }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();

  await assert.rejects(search, { name: "AbortError" });
  assert.equal(cancelRequest.operation_id, executeRequest.operation_id);
  provider.close();
  channel.port2.close();
});
