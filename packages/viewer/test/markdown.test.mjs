import assert from "node:assert/strict";
import test from "node:test";
import {
  isExternalMarkdownUrl,
  isStreamingAssistantText,
  prepareAssistantMarkdown,
  transformMarkdownUrl,
} from "../src/markdown.ts";

test("repairs only the render copy of actively streaming Markdown", () => {
  const boldSource = "**Still bold";
  const codeSource = "`partial code";
  const linkSource = "[Documentation](https://example.com/incompl";

  assert.equal(prepareAssistantMarkdown(boldSource, true), "**Still bold**");
  assert.equal(prepareAssistantMarkdown(codeSource, true), "`partial code`");
  assert.equal(prepareAssistantMarkdown(linkSource, true), "Documentation");
  assert.equal(boldSource, "**Still bold");
  assert.equal(codeSource, "`partial code");
  assert.equal(linkSource, "[Documentation](https://example.com/incompl");
});

test("holds an ambiguous trailing delimiter until the next stream delta", () => {
  assert.equal(prepareAssistantMarkdown("I’ll create a *", true), "I’ll create a");
  assert.equal(prepareAssistantMarkdown("*", true), "");
  assert.equal(
    prepareAssistantMarkdown("**Complete emphasis**", true),
    "**Complete emphasis**",
  );
  assert.equal(
    prepareAssistantMarkdown("`complete code`", true),
    "`complete code`",
  );
  assert.equal(
    prepareAssistantMarkdown("~~~md\n# Complete fence\n~~~", true),
    "~~~md\n# Complete fence\n~~~",
  );
  assert.equal(
    prepareAssistantMarkdown("```md\n# Partial fence\n`", true),
    "```md\n# Partial fence\n",
  );
  assert.equal(
    prepareAssistantMarkdown(String.raw`Escaped \*`, true),
    String.raw`Escaped \*`,
  );
});

test("leaves completed Markdown byte-for-byte unchanged", () => {
  const source = "**Unclosed emphasis\n\n[Incomplete link](https://example.com";

  assert.equal(prepareAssistantMarkdown(source, false), source);
});

test("does not repair incomplete inline or block math", () => {
  assert.equal(prepareAssistantMarkdown("$amount", true), "$amount");
  assert.equal(prepareAssistantMarkdown("$$x + y", true), "$$x + y");
});

test("identifies only the latest block in an active streaming entry", () => {
  assert.equal(isStreamingAssistantText("streaming", true, true), true);
  assert.equal(isStreamingAssistantText("streaming", true, false), false);
  assert.equal(isStreamingAssistantText("streaming", false, true), false);
  assert.equal(isStreamingAssistantText("complete", true, true), false);
  assert.equal(isStreamingAssistantText("aborted", true, true), false);
  assert.equal(isStreamingAssistantText("error", true, true), false);
});

test("allows external web links and same-document fragments", () => {
  assert.equal(
    transformMarkdownUrl("https://example.com/docs", "href"),
    "https://example.com/docs",
  );
  assert.equal(
    transformMarkdownUrl("http://localhost:3000/docs", "href"),
    "http://localhost:3000/docs",
  );
  assert.equal(
    transformMarkdownUrl("#user-content-note", "href"),
    "#user-content-note",
  );
  assert.equal(isExternalMarkdownUrl("https://example.com"), true);
  assert.equal(isExternalMarkdownUrl("#user-content-note"), false);
});

test("blocks active, local, and automatically loaded Markdown URLs", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///workspace/secret",
    "mailto:person@example.com",
    "/relative/path",
    "//example.com/path",
  ]) {
    assert.equal(transformMarkdownUrl(url, "href"), null);
    assert.equal(isExternalMarkdownUrl(url), false);
  }

  assert.equal(
    transformMarkdownUrl("https://example.com/tracker.png", "src"),
    null,
  );
});
