import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceRoot = new URL("../src/", import.meta.url);

test("mounts the shared viewer through the native worker transport", async () => {
  const [
    appSource,
    pageSource,
    transportSource,
    coreWorkerSource,
    llmWorkerSource,
  ] = await Promise.all([
    readFile(new URL("App.tsx", sourceRoot), "utf8"),
    readFile(new URL("pages/ResearchBoxPage.tsx", sourceRoot), "utf8"),
    readFile(new URL("lib/core-transport.ts", sourceRoot), "utf8"),
    readFile(new URL("workers/core.worker.ts", sourceRoot), "utf8"),
    readFile(new URL("workers/llm.worker.ts", sourceRoot), "utf8"),
  ]);

  assert.match(appSource, /@researchbox\/viewer\/styles\.css/);
  assert.match(appSource, /<ResearchBoxPage \/>/);
  assert.match(pageSource, /<ResearchBoxViewer/);
  assert.match(pageSource, /createTransport=\{createNativeCoreTransport\}/);
  assert.match(transportSource, /CoreTransportFactory/);
  assert.match(transportSource, /new WorkerCoreTransport/);
  assert.match(
    transportSource,
    /new URL\("\.\.\/workers\/core\.worker\.ts", import\.meta\.url\)/,
  );
  assert.match(coreWorkerSource, /startResearchBoxCoreWorker/);
  assert.match(coreWorkerSource, /InMemoryCommandLockManager/);
  assert.match(
    coreWorkerSource,
    /workerNavigator\.locks \?\? new InMemoryCommandLockManager\(\)/,
  );
  assert.match(coreWorkerSource, /include_local_openai:\s*false/);
  assert.match(
    coreWorkerSource,
    /new URL\("\.\/llm\.worker\.ts", import\.meta\.url\)/,
  );
  assert.match(llmWorkerSource, /attachNativeMockLlmWorker/);
});
