import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const piAiImport = /@earendil-works\/pi-ai/;

test("keeps the DSH runtime independent of Pi model types", async () => {
  const neutralSources = await Promise.all([
    "../src/model.ts",
    "../src/provider-catalog-service.ts",
    "../src/researchbox-core.ts",
    "../src/session-runtime-port.ts",
    "../../dshrbox-session-runtime/src/index.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const dshManifest = JSON.parse(await readFile(
    new URL("../../dshrbox-session-runtime/package.json", import.meta.url),
    "utf8",
  ));
  const legacyRuntime = await readFile(
    new URL("../src/session-runtime.ts", import.meta.url),
    "utf8",
  );

  for (const source of neutralSources) {
    assert.doesNotMatch(source, piAiImport);
  }
  assert.equal(
    dshManifest.dependencies["@earendil-works/pi-ai"],
    undefined,
  );
  assert.match(legacyRuntime, piAiImport);
});
