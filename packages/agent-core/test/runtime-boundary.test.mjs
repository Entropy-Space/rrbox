import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const piPackageImport = /@earendil-works\/pi-(?:agent-core|ai)/;

test("keeps neutral and DSH runtimes independent of Pi packages", async () => {
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
  const agentCoreManifest = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  const legacyManifest = JSON.parse(await readFile(
    new URL("../../runtime-legacy/package.json", import.meta.url),
    "utf8",
  ));
  const legacyRuntime = await readFile(
    new URL("../../runtime-legacy/src/session-runtime.ts", import.meta.url),
    "utf8",
  );

  for (const source of neutralSources) {
    assert.doesNotMatch(source, piPackageImport);
  }
  assert.equal(
    dshManifest.dependencies["@earendil-works/pi-ai"],
    undefined,
  );
  assert.equal(
    dshManifest.dependencies["@researchbox/runtime-legacy"],
    undefined,
  );
  assert.equal(
    agentCoreManifest.dependencies["@earendil-works/pi-ai"],
    undefined,
  );
  assert.equal(
    agentCoreManifest.dependencies["@earendil-works/pi-agent-core"],
    undefined,
  );
  assert.equal(
    legacyManifest.dependencies["@researchbox/agent-core"],
    "workspace:*",
  );
  assert.equal(
    legacyManifest.dependencies["@earendil-works/pi-ai"],
    "0.79.0",
  );
  assert.equal(
    legacyManifest.dependencies["@earendil-works/pi-agent-core"],
    "0.79.0",
  );
  assert.match(legacyRuntime, piPackageImport);
});
