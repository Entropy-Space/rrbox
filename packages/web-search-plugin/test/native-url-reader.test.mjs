import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_URL_READER_PROTOCOL_VERSION,
  parseNativeUrlReaderRequest,
} from "../src/native-url-reader-protocol.ts";
import { NativeUrlReader } from "../src/native-url-reader.ts";

test("opens a native URL read and converts its HTML to Markdown", async () => {
  const channel = new MessageChannel();
  const reader = new NativeUrlReader(channel.port1, { timeout_ms: 20_000 });
  channel.port2.onmessage = (event) => {
    const request = parseNativeUrlReaderRequest(event.data);
    assert.equal(request.kind, "url_reader_open");
    assert.equal(request.url, "https://example.com/");
    channel.port2.postMessage({
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
        content: "<title>Example</title><h1>Native page</h1>",
      },
    });
  };

  const result = await reader.open("https://example.com", "markdown");

  assert.equal(result.source, "direct");
  assert.equal(result.title, "Example");
  assert.match(result.content, /# Native page/u);
  reader.close();
  channel.port2.close();
});

test("rejects malformed native URL reader requests", () => {
  const request = {
    protocol_version: NATIVE_URL_READER_PROTOCOL_VERSION,
    request_id: "request",
    operation_id: "operation",
    kind: "url_reader_open",
    url: "https://example.com/",
    format: "markdown",
    timeout_ms: 20_000,
  };
  assert.deepEqual(parseNativeUrlReaderRequest(request), request);
  assert.throws(
    () => parseNativeUrlReaderRequest({ ...request, unexpected: true }),
    /unexpected fields/u,
  );
  assert.throws(
    () => parseNativeUrlReaderRequest({ ...request, timeout_ms: 1 }),
    /out of bounds/u,
  );
});
