import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const assetsUrl = new URL("../dist/client/assets/", import.meta.url);

test("emits and links separate core and LLM worker bundles", async () => {
  const assets = await readdir(assetsUrl);
  const appAsset = findOnly(assets, /^ResearchBoxApp-.*\.js$/);
  const coreAsset = findOnly(assets, /^core\.worker-.*\.js$/);
  const llmAsset = findOnly(assets, /^llm\.worker-.*\.js$/);
  const [appSource, coreSource, llmSource] = await Promise.all([
    readFile(new URL(appAsset, assetsUrl), "utf8"),
    readFile(new URL(coreAsset, assetsUrl), "utf8"),
    readFile(new URL(llmAsset, assetsUrl), "utf8"),
  ]);

  assert.match(appSource, new RegExp(escapeRegExp(coreAsset)));
  assert.match(coreSource, new RegExp(escapeRegExp(llmAsset)));
  assert.match(coreSource, /researchbox-llm/);
  assert.doesNotMatch(coreSource, /Model endpoint returned/);
  assert.match(llmSource, /Model endpoint returned/);
});

function findOnly(assets, pattern) {
  const matches = assets.filter((asset) => pattern.test(asset));
  assert.equal(matches.length, 1, `Expected one asset matching ${pattern}`);
  return matches[0];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
