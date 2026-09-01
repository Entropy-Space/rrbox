import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const piPackageImport = /@earendil-works\/pi-(?:agent-core|ai)/;
const legacyRuntimeImport = /@researchbox\/runtime-legacy/;
const legacyRuntimeApi = /LegacySessionRuntimeProvider|continueStagedPrompt/;

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

test("keeps the workspace independent of legacy Pi packages", async () => {
  const neutralSources = await Promise.all([
    "../src/model.ts",
    "../src/provider-catalog-service.ts",
    "../src/researchbox-core.ts",
    "../src/session-runtime-port.ts",
    "../../dshrbox-session-runtime/src/index.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const workspaceManifests = await readWorkspaceManifests();
  const workspaceLock = await readFile(
    new URL("../../../pnpm-lock.yaml", import.meta.url),
    "utf8",
  );
  const shippedWorkerSources = await Promise.all([
    "../../app-runtime-browser/src/researchbox-core-worker.ts",
    "../../../apps/web/browser/core.worker.ts",
    "../../../apps/native/src/workers/core.worker.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const featureSources = (await Promise.all([
    readTypeScriptSources("../../python-plugin/src/"),
    readTypeScriptSources("../../web-search-plugin/src/"),
  ])).flat();

  for (const source of neutralSources) {
    assert.doesNotMatch(source, piPackageImport);
    assert.doesNotMatch(source, legacyRuntimeApi);
  }
  for (const source of featureSources) {
    assert.doesNotMatch(source, piPackageImport);
    assert.doesNotMatch(source, legacyRuntimeImport);
  }
  for (const source of shippedWorkerSources) {
    assert.doesNotMatch(source, piPackageImport);
    assert.doesNotMatch(source, legacyRuntimeImport);
  }
  for (const manifest of workspaceManifests) {
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
  assert.doesNotMatch(workspaceLock, piPackageImport);
  assert.doesNotMatch(workspaceLock, legacyRuntimeImport);
  await assert.rejects(
    readFile(
      new URL("../../runtime-legacy/package.json", import.meta.url),
      "utf8",
    ),
    (error) => error?.code === "ENOENT",
  );
});

async function readWorkspaceManifests() {
  const packageDirectory = new URL("../../", import.meta.url);
  const appDirectory = new URL("../../../apps/", import.meta.url);
  const manifestUrls = [];
  for (const directory of [packageDirectory, appDirectory]) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      manifestUrls.push(new URL(`${entry.name}/package.json`, directory));
    }
  }
  const manifests = await Promise.all(manifestUrls.map(async (url) => {
    try {
      return JSON.parse(await readFile(url, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }));
  return manifests.filter((manifest) => manifest !== null);
}
