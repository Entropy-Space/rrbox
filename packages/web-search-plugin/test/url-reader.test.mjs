import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePublicHttpUrl,
  openUrl,
} from "../src/url-reader.ts";

test("returns raw HTML from a direct URL request", async () => {
  const html = "<html><head><title>Example page</title></head><body><h1>Hello</h1></body></html>";
  const result = await openUrl(
    "https://example.com/page",
    "html",
    undefined,
    async () => new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );

  assert.equal(result.content, html);
  assert.equal(result.title, "Example page");
  assert.equal(result.content_type, "text/html");
  assert.equal(result.source, "direct");
});

test("converts directly available HTML into readable Markdown", async () => {
  const result = await openUrl(
    "https://example.com/page",
    "markdown",
    undefined,
    async () => new Response(
      "<title>Example</title><h1>Welcome</h1><p>Read <a href=\"/docs\">the docs</a>.</p><script>ignore()</script>",
      { headers: { "content-type": "text/html" } },
    ),
  );

  assert.match(result.content, /# Welcome/u);
  assert.match(result.content, /\[the docs\]\(\/docs\)/u);
  assert.doesNotMatch(result.content, /ignore\(\)/u);
});

test("uses the reader fallback for Markdown when a direct request is unavailable", async () => {
  const requests = [];
  const result = await openUrl(
    "https://example.com/article",
    "markdown",
    undefined,
    async (url) => {
      requests.push(String(url));
      if (requests.length === 1) throw new TypeError("Failed to fetch");
      return new Response(
        "Title: Reader article\nURL Source: https://example.com/article\nMarkdown Content:\n# Reader article\n\nReadable page.",
        { headers: { "content-type": "text/plain" } },
      );
    },
  );

  assert.deepEqual(requests, [
    "https://example.com/article",
    "https://r.jina.ai/https://example.com/article",
  ]);
  assert.equal(result.source, "reader");
  assert.equal(result.title, "Reader article");
  assert.equal(result.content, "# Reader article\n\nReadable page.");
});

test("rejects private and credential-bearing URL targets before fetching", () => {
  for (const value of [
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "http://[::1]/admin",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "https://user:secret@example.com/",
    "file:///tmp/secret.txt",
  ]) {
    assert.throws(
      () => normalizePublicHttpUrl(value),
      /public hostname|embedded credentials|HTTP or HTTPS/u,
    );
  }
});
