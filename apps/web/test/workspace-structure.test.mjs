import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("keeps the proposed workspace surfaces present", async () => {
  const expectedPaths = [
    "apps/web",
    "apps/native",
    "packages/client",
    "packages/app-runtime-browser",
    "packages/mock-provider",
    "packages/protocol",
    "packages/agent-core",
    "packages/viewer",
    "packages/model-transport",
    "packages/project-store",
    "packages/python-plugin",
    "packages/runtime-browser",
    "packages/storage-browser",
    "packages/storage-native",
    "packages/vfs",
    "packages/workspace-archive",
  ];

  await Promise.all(
    expectedPaths.map((relativePath) => access(path.join(root, relativePath))),
  );
  await Promise.all(
    [
      "apps/mock-server",
      "apps/web/browser/browser-runtime.ts",
      "apps/web/browser/command-coordinator.ts",
      "apps/web/browser/mock-model.ts",
      "apps/web/browser/seed-files.ts",
      "apps/web/browser/persistence",
      "apps/web/browser/workspace-transfer-limits.ts",
      "platforms/ios",
      "platforms/desktop",
    ].map((relativePath) =>
      assert.rejects(access(path.join(root, relativePath))),
    ),
  );
  await assert.rejects(access(path.join(root, ".openai", "hosting.json")));
});

test("shares browser app runtime composition between web and native", async () => {
  const [runtimeManifestSource, webManifestSource, nativeManifestSource] =
    await Promise.all([
      readFile(
        path.join(root, "packages/app-runtime-browser/package.json"),
        "utf8",
      ),
      readFile(path.join(root, "apps/web/package.json"), "utf8"),
      readFile(path.join(root, "apps/native/package.json"), "utf8"),
    ]);
  const runtimeManifest = JSON.parse(runtimeManifestSource);
  const webManifest = JSON.parse(webManifestSource);
  const nativeManifest = JSON.parse(nativeManifestSource);

  assert.equal(runtimeManifest.name, "@researchbox/app-runtime-browser");
  assert.equal(runtimeManifest.exports["."], undefined);
  assert.equal(
    runtimeManifest.exports["./core-worker"],
    "./src/researchbox-core-worker.ts",
  );
  assert.equal(
    runtimeManifest.exports["./mock-model"],
    "./src/mock-model.ts",
  );
  assert.equal(
    runtimeManifest.exports["./runtime"],
    "./src/browser-runtime.ts",
  );
  assert.equal(
    runtimeManifest.exports["./command-coordinator"],
    "./src/command-coordinator.ts",
  );
  assert.equal(
    runtimeManifest.exports["./workspace-transfer-limits"],
    "./src/workspace-transfer-limits.ts",
  );
  assert.equal(
    runtimeManifest.dependencies["@researchbox/storage-browser"],
    "workspace:*",
  );
  assert.equal(
    runtimeManifest.dependencies["@researchbox/runtime-browser"],
    "workspace:*",
  );
  assert.equal(
    webManifest.dependencies["@researchbox/app-runtime-browser"],
    "workspace:*",
  );
  assert.equal(
    nativeManifest.dependencies["@researchbox/app-runtime-browser"],
    "workspace:*",
  );
  assert.equal(
    nativeManifest.dependencies["@researchbox/storage-native"],
    "workspace:*",
  );
  assert.equal(
    webManifest.dependencies["@researchbox/python-plugin"],
    "workspace:*",
  );
  assert.equal(
    nativeManifest.dependencies["@researchbox/python-plugin"],
    "workspace:*",
  );
});

test("keeps framework dependencies out of portable packages", async () => {
  const portablePackages = [
    "client",
    "protocol",
    "model-transport",
    "runtime-browser",
    "project-store",
    "storage-native",
    "vfs",
    "workspace-archive",
    "python-plugin",
  ];
  const forbiddenDependencies = new Set([
    "@tauri-apps/api",
    "next",
    "react",
    "vinext",
    "vite",
    "wrangler",
  ]);

  for (const packageName of portablePackages) {
    const manifest = JSON.parse(
      await readFile(
        path.join(root, "packages", packageName, "package.json"),
        "utf8",
      ),
    );
    const dependencies = Object.keys(manifest.dependencies ?? {});
    assert.deepEqual(
      dependencies.filter((dependency) => forbiddenDependencies.has(dependency)),
      [],
      `${packageName} contains a framework dependency`,
    );
  }
});

test("keeps native tooling inside the Tauri composition root", async () => {
  const [manifestSource, tauriConfigSource, cargoManifest] = await Promise.all([
    readFile(path.join(root, "apps/native/package.json"), "utf8"),
    readFile(
      path.join(root, "apps/native/src-tauri/tauri.conf.json"),
      "utf8",
    ),
    readFile(path.join(root, "apps/native/src-tauri/Cargo.toml"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const tauriConfig = JSON.parse(tauriConfigSource);

  assert.equal(manifest.packageManager, undefined);
  assert.equal(manifest.devDependencies["@tauri-apps/cli"], "^2");
  assert.equal(manifest.dependencies["@tauri-apps/api"], "^2");
  assert.equal(tauriConfig.build.frontendDist, "../dist");
  assert.equal(tauriConfig.build.devUrl, "http://localhost:1420");
  assert.match(cargoManifest, /^tauri = \{ version = "2"/m);
});

test("uses ResearchBox casing in authored text files", async () => {
  const legacyBrand = ["Research", "box"].join("");
  const authoredRoots = ["README.md", "ARCHITECTURE.md", "apps", "packages"];
  const files = [];

  for (const authoredRoot of authoredRoots) {
    const absolutePath = path.join(root, authoredRoot);
    const statEntries = await collectTextFiles(absolutePath);
    files.push(...statEntries);
  }

  for (const file of files) {
    const content = await readFile(file, "utf8");
    assert.equal(
      content.includes(legacyBrand),
      false,
      `${path.relative(root, file)} uses the retired brand casing`,
    );
  }
});

async function collectTextFiles(target) {
  const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [target];

  const files = [];
  for (const entry of entries) {
    if (["dist", ".next", ".vinext", ".wrangler", "node_modules"].includes(entry.name)) {
      continue;
    }
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(entryPath)));
    } else if (/\.(?:json|md|mjs|ts|tsx|yaml)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}
