import assert from "node:assert/strict";
import test from "node:test";
import { createNativeUrlReaderPortBroker } from "../src/lib/native-url-reader-broker.ts";
import {
  NATIVE_URL_READER_PROTOCOL_VERSION,
  parseNativeUrlReaderResponse,
} from "@researchbox/web-search-plugin/native-url-reader-protocol";

test("brokers native URL reader responses", async () => {
  const channel = new MessageChannel();
  const broker = createNativeUrlReaderPortBroker(channel.port1, {
    async open(request) {
      return {
        protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
        request_id: request.request_id,
        operation_id: request.operation_id,
        kind: "url_reader_open_result",
        success: true,
        result: {
          requested_url: request.url,
          final_url: request.url,
          status: 200,
          content_type: "text/html",
          content: "<h1>Example</h1>",
        },
      };
    },
    async cancel(request) {
      return {
        protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
        request_id: request.request_id,
        operation_id: request.operation_id,
        kind: "url_reader_cancel_result",
        cancelled: true,
      };
    },
  });
  const response = new Promise((resolve) => {
    channel.port2.onmessage = (event) => resolve(event.data);
  });
  channel.port2.postMessage({
    protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
    request_id: "request",
    operation_id: "operation",
    kind: "url_reader_open",
    url: "https://example.com/",
    format: "markdown",
    timeout_ms: 20_000,
  });

  const parsed = parseNativeUrlReaderResponse(await response);
  assert.equal(parsed.kind, "url_reader_open_result");
  assert.equal(parsed.success, true);
  broker.close();
  channel.port2.close();
});
