import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../..", import.meta.url));

test("keeps the proposed workspace surfaces present", async () => {
  const expectedPaths = [
    "apps/web",
    "apps/mock-server",
    "packages/protocol",
    "packages/agent-core",
    "packages/viewer",
    "packages/model-transport",
    "packages/project-store",
    "packages/runtime-browser",
    "packages/vfs",
    "platforms/ios",
    "platforms/desktop",
  ];

  await Promise.all(
    expectedPaths.map((relativePath) => access(path.join(root, relativePath))),
  );
  await assert.rejects(access(path.join(root, ".openai", "hosting.json")));
});

test("keeps framework dependencies out of portable packages", async () => {
  const portablePackages = [
    "protocol",
    "model-transport",
    "runtime-browser",
    "project-store",
    "vfs",
  ];
  const forbiddenDependencies = new Set([
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

test("uses ResearchBox casing in authored text files", async () => {
  const legacyBrand = ["Research", "box"].join("");
  const authoredRoots = ["README.md", "ARCHITECTURE.md", "apps", "packages", "platforms"];
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
