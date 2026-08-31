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
    pythonBrokerSource,
    webSearchBrokerSource,
    urlReaderBrokerSource,
    viteConfigSource,
    nativeManifestSource,
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
    readFile(
      new URL("lib/native-python-broker.ts", sourceRoot),
      "utf8",
    ),
    readFile(
      new URL("lib/native-web-search-broker.ts", sourceRoot),
      "utf8",
    ),
    readFile(
      new URL("lib/native-url-reader-broker.ts", sourceRoot),
      "utf8",
    ),
    readFile(new URL("../vite.config.ts", sourceRoot), "utf8"),
    readFile(new URL("../package.json", sourceRoot), "utf8"),
  ]);
  const nativeManifest = JSON.parse(nativeManifestSource);

  assert.match(appSource, /@researchbox\/viewer\/styles\.css/);
  assert.match(appSource, /<ResearchBoxPage \/>/);
  assert.match(pageSource, /<ResearchBoxViewer/);
  assert.match(pageSource, /loadNativeProviderRuntimeConfigurations/);
  assert.match(pageSource, /createNativeCoreTransport\(providers \?\? \[\]\)/);
  assert.match(pageSource, /providerSettingsAdapter=\{providerSettingsAdapter\}/);
  assert.match(transportSource, /CoreTransportFactory/);
  assert.match(transportSource, /new WorkerCoreTransport/);
  assert.match(transportSource, /new MessageChannel/);
  assert.match(transportSource, /createNativeStoragePortBroker/);
  assert.match(transportSource, /createNativeProviderPortBroker/);
  assert.match(transportSource, /createNativePythonPortBroker/);
  assert.match(transportSource, /createNativeWebSearchPortBroker/);
  assert.match(transportSource, /createNativeUrlReaderPortBroker/);
  assert.match(transportSource, /provider_port:\s*providerChannel\.port2/);
  assert.match(transportSource, /python_port:\s*pythonChannel\.port2/);
  assert.match(
    transportSource,
    /web_search_port:\s*webSearchChannel\.port2/,
  );
  assert.match(
    transportSource,
    /url_reader_port:\s*urlReaderChannel\.port2/,
  );
  assert.match(
    transportSource,
    /new URL\("\.\.\/workers\/core\.worker\.ts", import\.meta\.url\)/,
  );
  assert.match(coreWorkerSource, /startResearchBoxCoreWorker/);
  assert.match(coreWorkerSource, /NativeStorageRpcClient/);
  assert.match(coreWorkerSource, /NativeProjectStore/);
  assert.match(coreWorkerSource, /NativeWorkspaceBackend/);
  assert.match(coreWorkerSource, /NativeDshrboxSessionBackend/);
  assert.match(coreWorkerSource, /DshrboxSessionRuntimeProvider/);
  assert.match(coreWorkerSource, /DSH_BROWSER_COMPATIBILITY/);
  assert.match(coreWorkerSource, /create_storage_services/);
  assert.match(coreWorkerSource, /InMemoryCommandLockManager/);
  assert.match(
    coreWorkerSource,
    /workerNavigator\.locks \?\? new InMemoryCommandLockManager\(\)/,
  );
  assert.match(coreWorkerSource, /providers:\s*initialization\.providers/);
  assert.match(coreWorkerSource, /native_llm_initialize/);
  assert.match(coreWorkerSource, /initialization\.provider_port/);
  assert.match(coreWorkerSource, /NativePythonRpcClient/);
  assert.match(coreWorkerSource, /createPythonAgentPlugin/);
  assert.match(coreWorkerSource, /DshrboxPython/);
  assert.match(coreWorkerSource, /RoutingWebSearchExecutor/);
  assert.match(coreWorkerSource, /ExaMcpWebSearchProvider/);
  assert.match(coreWorkerSource, /NativeAnySearchWebSearchProvider/);
  assert.match(coreWorkerSource, /NativeUrlReader/);
  assert.match(coreWorkerSource, /createWebSearchAgentPlugin/);
  assert.match(coreWorkerSource, /DshrboxWebResearch/);
  assert.match(coreWorkerSource, /legacy_plugins:\s*legacyPlugins/);
  assert.match(coreWorkerSource, /plugins:\s*dshPlugins/);
  assert.match(
    coreWorkerSource,
    /session_backend:\s*\(projectId\)\s*=>\s*\n\s*new NativeDshrboxSessionBackend\(storageClient, projectId\)/,
  );
  assert.match(
    coreWorkerSource,
    /sessionRuntimeProvider:\s*new DshrboxSessionRuntimeProvider/,
  );
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
  assert.match(tauriSource, /NATIVE_PYTHON_EXECUTE_COMMAND/);
  assert.match(tauriSource, /NATIVE_PYTHON_CANCEL_COMMAND/);
  assert.match(tauriSource, /NATIVE_WEB_SEARCH_EXECUTE_COMMAND/);
  assert.match(tauriSource, /NATIVE_WEB_SEARCH_CANCEL_COMMAND/);
  assert.match(tauriSource, /NATIVE_URL_READER_OPEN_COMMAND/);
  assert.match(tauriSource, /NATIVE_URL_READER_CANCEL_COMMAND/);
  assert.match(pythonBrokerSource, /parsePythonRequest/);
  assert.match(pythonBrokerSource, /nativePythonCommands/);
  assert.match(webSearchBrokerSource, /parseNativeWebSearchRequest/);
  assert.match(webSearchBrokerSource, /nativeWebSearchCommands/);
  assert.match(urlReaderBrokerSource, /parseNativeUrlReaderRequest/);
  assert.match(urlReaderBrokerSource, /nativeUrlReaderCommands/);
  assert.match(pageSource, /nativeWebSearchPluginCatalogEntry/);
  assert.match(viteConfigSource, /dshBrowserCompatibilityAliases/);
  assert.match(
    viteConfigSource,
    /alias:\s*dshBrowserCompatibilityAliases\(\)/,
  );
  assert.equal(
    nativeManifest.dependencies["@dshrbox/runtime-browser"],
    "workspace:*",
  );
  assert.equal(
    nativeManifest.dependencies["@dshrbox/session-persistence-native"],
    "workspace:*",
  );
  assert.equal(
    nativeManifest.dependencies["@dshrbox/session-runtime"],
    "workspace:*",
  );
});
