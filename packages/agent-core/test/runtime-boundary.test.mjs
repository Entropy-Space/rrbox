import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const piPackageImport = /@earendil-works\/pi-(?:agent-core|ai)/;
const legacyRuntimeImport = /@researchbox\/runtime-legacy/;

async function readTypeScriptSources(directoryPath) {
  const directory = directoryPath instanceof URL
    ? directoryPath
    : new URL(directoryPath, import.meta.url);
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return readTypeScriptSources(new URL(`${entry.name}/`, directory));
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) return [];
    return [await readFile(new URL(entry.name, directory), "utf8")];
  }));
  return sources.flat();
}

test("keeps feature and DSH runtimes independent of Pi packages", async () => {
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
  const pythonManifest = JSON.parse(await readFile(
    new URL("../../python-plugin/package.json", import.meta.url),
    "utf8",
  ));
  const webSearchManifest = JSON.parse(await readFile(
    new URL("../../web-search-plugin/package.json", import.meta.url),
    "utf8",
  ));
  const legacyManifest = JSON.parse(await readFile(
    new URL("../../runtime-legacy/package.json", import.meta.url),
    "utf8",
  ));
  const featureSources = (await Promise.all([
    readTypeScriptSources("../../python-plugin/src/"),
    readTypeScriptSources("../../web-search-plugin/src/"),
  ])).flat();
  const legacyRuntime = await readFile(
    new URL("../../runtime-legacy/src/session-runtime.ts", import.meta.url),
    "utf8",
  );

  for (const source of neutralSources) {
    assert.doesNotMatch(source, piPackageImport);
  }
  for (const source of featureSources) {
    assert.doesNotMatch(source, piPackageImport);
    assert.doesNotMatch(source, legacyRuntimeImport);
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
  for (const manifest of [pythonManifest, webSearchManifest]) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    assert.equal(
      dependencies["@earendil-works/pi-ai"],
      undefined,
    );
    assert.equal(
      dependencies["@earendil-works/pi-agent-core"],
      undefined,
    );
    assert.equal(
      dependencies["@researchbox/runtime-legacy"],
      undefined,
    );
  }
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
  assert.equal(
    legacyManifest.dependencies["@researchbox/python-plugin"],
    "workspace:*",
  );
  assert.equal(
    legacyManifest.dependencies["@researchbox/web-search-plugin"],
    "workspace:*",
  );
  assert.match(legacyRuntime, piPackageImport);
});
