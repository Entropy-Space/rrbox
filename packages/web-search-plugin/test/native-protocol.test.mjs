import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
  parseNativeWebSearchRequest,
  parseNativeWebSearchResponse,
} from "../src/native-protocol.ts";

test("strictly round-trips native web search messages", () => {
  const execute = {
    protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
    request_id: "request-1",
    operation_id: "operation-1",
    kind: "web_search_execute",
    provider_id: "anysearch",
    query: "rust wasm",
    num_results: 5,
    include_content: true,
    timeout_ms: 20_000,
  };
  assert.deepEqual(parseNativeWebSearchRequest(execute), execute);
  assert.deepEqual(
    parseNativeWebSearchRequest({
      protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
      request_id: "request-2",
      operation_id: "operation-1",
      kind: "web_search_cancel",
    }),
    {
      protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
      request_id: "request-2",
      operation_id: "operation-1",
      kind: "web_search_cancel",
    },
  );
  const response = {
    protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
    request_id: "request-1",
    operation_id: "operation-1",
    kind: "web_search_execute_result",
    success: true,
    response: {
      query: "rust wasm",
      provider: "anysearch",
      answer: "Answer",
      sources: [{
        title: "Source",
        url: "https://example.com/",
        snippet: "Snippet",
        content: "Content",
      }],
    },
  };
  assert.deepEqual(parseNativeWebSearchResponse(response), response);
});

test("rejects unsafe or unbounded native web search messages", () => {
  const execute = {
    protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
    request_id: "request-1",
    operation_id: "operation-1",
    kind: "web_search_execute",
    provider_id: "anysearch",
    query: "rust wasm",
    num_results: 5,
    include_content: false,
    timeout_ms: 20_000,
  };
  assert.throws(
    () => parseNativeWebSearchRequest({ ...execute, endpoint: "http://local" }),
    /unexpected fields/u,
  );
  assert.throws(
    () => parseNativeWebSearchRequest({ ...execute, num_results: 21 }),
    /out of bounds/u,
  );
  assert.throws(
    () =>
      parseNativeWebSearchResponse({
        protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
        request_id: "request-1",
        operation_id: "operation-1",
        kind: "web_search_execute_result",
        success: true,
        response: {
          query: "rust wasm",
          provider: "anysearch",
          answer: "Answer",
          sources: [{
            title: "Local",
            url: "file:///tmp/private",
            snippet: "",
          }],
        },
      }),
    /HTTP\(S\)/u,
  );
});
