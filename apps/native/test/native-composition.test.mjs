import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceRoot = new URL("../src/", import.meta.url);

test("mounts the shared viewer through the native worker transport", async () => {
  const [
    appSource,
    pageSource,
    transportSource,
    brokerSource,
    tauriSource,
    coreWorkerSource,
    llmWorkerSource,
    nativeLlmSource,
  ] = await Promise.all([
    readFile(new URL("App.tsx", sourceRoot), "utf8"),
    readFile(new URL("pages/ResearchBoxPage.tsx", sourceRoot), "utf8"),
    readFile(new URL("lib/core-transport.ts", sourceRoot), "utf8"),
    readFile(
      new URL("lib/native-storage-broker.ts", sourceRoot),
      "utf8",
    ),
    readFile(new URL("lib/tauri.ts", sourceRoot), "utf8"),
    readFile(new URL("workers/core.worker.ts", sourceRoot), "utf8"),
    readFile(new URL("workers/llm.worker.ts", sourceRoot), "utf8"),
    readFile(new URL("runtime/native-llm.ts", sourceRoot), "utf8"),
  ]);

  assert.match(appSource, /@researchbox\/viewer\/styles\.css/);
  assert.match(appSource, /<ResearchBoxPage \/>/);
  assert.match(pageSource, /<ResearchBoxViewer/);
  assert.match(pageSource, /createTransport=\{createNativeCoreTransport\}/);
  assert.match(transportSource, /CoreTransportFactory/);
  assert.match(transportSource, /new WorkerCoreTransport/);
  assert.match(transportSource, /new MessageChannel/);
  assert.match(transportSource, /createNativeStoragePortBroker/);
  assert.match(transportSource, /createNativeProviderPortBroker/);
  assert.match(transportSource, /provider_port:\s*providerChannel\.port2/);
  assert.match(
    transportSource,
    /new URL\("\.\.\/workers\/core\.worker\.ts", import\.meta\.url\)/,
  );
  assert.match(coreWorkerSource, /startResearchBoxCoreWorker/);
  assert.match(coreWorkerSource, /NativeStorageRpcClient/);
  assert.match(coreWorkerSource, /NativeProjectStore/);
  assert.match(coreWorkerSource, /NativeWorkspaceBackend/);
  assert.match(coreWorkerSource, /create_storage_services/);
  assert.match(coreWorkerSource, /InMemoryCommandLockManager/);
  assert.match(
    coreWorkerSource,
    /workerNavigator\.locks \?\? new InMemoryCommandLockManager\(\)/,
  );
  assert.match(coreWorkerSource, /include_local_openai:\s*true/);
  assert.match(coreWorkerSource, /native_llm_initialize/);
  assert.match(coreWorkerSource, /initialization\.provider_port/);
  assert.match(
    coreWorkerSource,
    /new URL\("\.\/llm\.worker\.ts", import\.meta\.url\)/,
  );
  assert.match(llmWorkerSource, /attachNativeLlmWorker/);
  assert.match(
    llmWorkerSource,
    /parseNativeLlmWorkerInitializeMessage/,
  );
  assert.match(
    nativeLlmSource,
    /NativeOpenAiCompatibleModelTransport/,
  );
  assert.match(nativeLlmSource, /nativeMockModel/);
  assert.match(brokerSource, /parseNativeStorageRequest/);
  assert.match(brokerSource, /invokeNativeStorageRequest/);
  assert.match(tauriSource, /invoke<unknown>\(NATIVE_STORAGE_COMMAND/);
  assert.match(tauriSource, /NATIVE_PROVIDER_FETCH_COMMAND/);
  assert.match(tauriSource, /NATIVE_PROVIDER_CANCEL_COMMAND/);
});
