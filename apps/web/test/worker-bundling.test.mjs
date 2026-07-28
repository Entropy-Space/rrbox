import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const assetsUrl = new URL("../dist/client/assets/", import.meta.url);
const MAX_FOCUSED_WORKER_BYTES = 256 * 1024;

test("emits and links separate core, LLM, and archive worker bundles", async () => {
  const assets = await readdir(assetsUrl);
  const appAsset = findOnly(assets, /^ResearchBoxApp-.*\.js$/);
  const coreAsset = findOnly(assets, /^core\.worker-.*\.js$/);
  const llmAsset = findOnly(assets, /^llm\.worker-.*\.js$/);
  const archiveAsset = findOnly(assets, /^archive\.worker-.*\.js$/);
  const [appSource, coreSource, llmSource, archiveSource] = await Promise.all([
    readFile(new URL(appAsset, assetsUrl), "utf8"),
    readFile(new URL(coreAsset, assetsUrl), "utf8"),
    readFile(new URL(llmAsset, assetsUrl), "utf8"),
    readFile(new URL(archiveAsset, assetsUrl), "utf8"),
  ]);

  assert.match(appSource, new RegExp(escapeRegExp(coreAsset)));
  assert.match(appSource, new RegExp(escapeRegExp(archiveAsset)));
  assert.doesNotMatch(appSource, /researchbox-workspace\.json/);
  assert.match(coreSource, new RegExp(escapeRegExp(llmAsset)));
  assert.match(coreSource, /researchbox-llm/);
  assert.doesNotMatch(coreSource, /Model endpoint returned/);
  assert.doesNotMatch(coreSource, /researchbox-workspace\.json/);
  assert.match(llmSource, /Model endpoint returned/);
  assert.match(archiveSource, /researchbox-workspace\.json/);
  assert.match(archiveSource, /workspace_archive_encoded/);
  assertFocusedWorkerSize("LLM", llmSource);
  assertFocusedWorkerSize("archive", archiveSource);
});

function findOnly(assets, pattern) {
  const matches = assets.filter((asset) => pattern.test(asset));
  assert.equal(matches.length, 1, `Expected one asset matching ${pattern}`);
  return matches[0];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertFocusedWorkerSize(label, source) {
  const byteLength = Buffer.byteLength(source);
  assert.ok(
    byteLength <= MAX_FOCUSED_WORKER_BYTES,
    `${label} worker is ${byteLength} bytes; check for broad barrel imports`,
  );
}
