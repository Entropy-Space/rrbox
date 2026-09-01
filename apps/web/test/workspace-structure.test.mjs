import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const obsoleteRuntimeDocumentation =
  /\bPi\b|runtime-legacy|legacy runtime|v1 agent runtime/;

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
    "packages/dshrbox-session-persistence-native",
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

test("documents DSH as the only executable session runtime", async () => {
  const packageEntries = await readdir(path.join(root, "packages"), {
    withFileTypes: true,
  });
  const documentationPaths = [
    path.join(root, "README.md"),
    path.join(root, "ARCHITECTURE.md"),
    ...packageEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, "packages", entry.name, "README.md")),
  ];
  const documents = (await Promise.all(
    documentationPaths.map(async (filePath) => {
      try {
        return {
          file_path: filePath,
          source: await readFile(filePath, "utf8"),
        };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    }),
  )).filter((document) => document !== null);

  for (const document of documents) {
    assert.doesNotMatch(
      document.source,
      obsoleteRuntimeDocumentation,
      `${path.relative(root, document.file_path)} describes a deleted runtime`,
    );
  }

  const rootReadme = documents.find(
    (document) => document.file_path === path.join(root, "README.md"),
  )?.source;
  const architecture = documents.find(
    (document) => document.file_path === path.join(root, "ARCHITECTURE.md"),
  )?.source;
  assert.ok(rootReadme);
  assert.ok(architecture);
  assert.match(rootReadme, /DSH is the only executable session runtime/);
  assert.match(
    rootReadme,
    /migrate into a new DSH\s+child on their first write/,
  );
  assert.match(
    architecture,
    /`packages\/dshrbox-session-runtime` is the only executable session provider/,
  );
  assert.match(
    architecture,
    /Unmarked timeline documents remain passive until a write creates and seeds a\s+distinct DSH child session/,
  );
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
    undefined,
  );
  assert.equal(
    runtimeManifest.dependencies["@researchbox/runtime-browser"],
    "workspace:*",
  );
  assert.equal(
    runtimeManifest.dependencies["@researchbox/runtime-legacy"],
    undefined,
  );
  assert.equal(runtimeManifest.dependencies["@dshrbox/session-runtime"], undefined);
  assert.equal(
    webManifest.dependencies["@researchbox/app-runtime-browser"],
    "workspace:*",
  );
  assert.equal(
    webManifest.dependencies["@dshrbox/runtime-browser"],
    "workspace:*",
  );
  assert.equal(
    webManifest.dependencies["@dshrbox/session-runtime"],
    "workspace:*",
  );
  assert.equal(
    webManifest.dependencies["@dshrbox/session-persistence-browser"],
    "workspace:*",
  );
  assert.equal(
    webManifest.dependencies["@researchbox/runtime-legacy"],
    undefined,
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
    nativeManifest.dependencies["@dshrbox/runtime-browser"],
    "workspace:*",
  );
  assert.equal(
    nativeManifest.dependencies["@dshrbox/session-runtime"],
    "workspace:*",
  );
  assert.equal(
    nativeManifest.dependencies["@dshrbox/session-persistence-native"],
    "workspace:*",
  );
  assert.equal(
    nativeManifest.dependencies["@researchbox/runtime-legacy"],
    undefined,
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

test("does not expose the retired product brand", async () => {
  const retiredBrand = new RegExp(`\\b${["Research", "Box"].join("")}\\b`, "u");
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
      retiredBrand.test(content),
      false,
      `${path.relative(root, file)} exposes the retired product brand`,
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
