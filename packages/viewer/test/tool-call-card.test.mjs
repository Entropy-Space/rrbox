import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewerSource = await readFile(
  new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
  "utf8",
);
const stylesSource = await readFile(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

test("tool cards expose a keyboard-accessible disclosure button", () => {
  const toolCardSource = viewerSource.slice(
    viewerSource.indexOf("function ToolCallCard"),
    viewerSource.indexOf("function ToolCallPayload"),
  );

  assert.match(toolCardSource, /<button[\s\S]*className="tool-card-summary"/);
  assert.match(toolCardSource, /aria-expanded=\{isExpanded\}/);
  assert.match(
    toolCardSource,
    /onClick=\{\(\) => setIsExpanded\(\(expanded\) => !expanded\)\}/,
  );
  assert.match(toolCardSource, /\{isExpanded && \(/);
  assert.match(toolCardSource, /label="Input"/);
  assert.match(toolCardSource, /label="Output"/);
  assert.match(
    toolCardSource,
    /!result && block\.progress_summary/,
  );
});

test("expanded tool payloads preserve whitespace and bound long content", () => {
  assert.match(stylesSource, /\.tool-call-payload pre \{/);
  assert.match(stylesSource, /max-height: 260px;/);
  assert.match(stylesSource, /overflow: auto;/);
  assert.match(stylesSource, /white-space: pre-wrap;/);
  assert.match(
    stylesSource,
    /\.tool-card\[data-expanded="true"\] \.tool-card-chevron \{[\s\S]*rotate\(90deg\)/,
  );
});
