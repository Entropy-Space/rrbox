import assert from "node:assert/strict";
import test from "node:test";
import { createNativeWebSearchPortBroker } from "../src/lib/native-web-search-broker.ts";
import {
  NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
  parseNativeWebSearchResponse,
} from "@researchbox/web-search-plugin/native-protocol";

test("brokers native web search responses", async () => {
  const channel = new MessageChannel();
  const broker = createNativeWebSearchPortBroker(channel.port1, {
    async execute(request) {
      return {
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
      };
    },
    async cancel(request) {
      return {
        protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
        request_id: request.request_id,
        operation_id: request.operation_id,
        kind: "web_search_cancel_result",
        cancelled: true,
      };
    },
  });
  const response = new Promise((resolve) => {
    channel.port2.onmessage = (event) => resolve(event.data);
  });
  channel.port2.postMessage({
    protocol_version: NATIVE_WEB_SEARCH_PROTOCOL_VERSION,
    request_id: "request",
    operation_id: "operation",
    kind: "web_search_execute",
    provider_id: "anysearch",
    query: "rust wasm",
    num_results: 5,
    include_content: false,
    timeout_ms: 20_000,
  });

  const parsed = parseNativeWebSearchResponse(await response);
  assert.equal(parsed.kind, "web_search_execute_result");
  assert.equal(parsed.success, true);
  broker.close();
  channel.port2.close();
});
