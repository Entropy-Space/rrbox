import type { CoreTransportFactory } from "@researchbox/client";
import {
  resolvePythonPluginRuntimeConfiguration,
} from "@researchbox/python-plugin/settings";
import {
  resolveWebSearchPluginRuntimeConfiguration,
} from "@researchbox/web-search-plugin/settings";
import { WorkerCoreTransport } from "@researchbox/runtime-browser";
import { loadPluginSettings } from "@researchbox/viewer";
import {
  createNativeProviderPortBroker,
} from "./native-provider-broker.ts";
import {
  createNativePythonPortBroker,
} from "./native-python-broker.ts";
import {
  createNativeWebSearchPortBroker,
} from "./native-web-search-broker.ts";
import {
  createNativeUrlReaderPortBroker,
} from "./native-url-reader-broker.ts";
import { createNativeStoragePortBroker } from "./native-storage-broker.ts";
import {
  NATIVE_CORE_WORKER_PROTOCOL_VERSION,
  type NativeCoreWorkerInitializeMessage,
} from "./types.ts";
import type { ProviderRuntimeConfiguration } from "@researchbox/provider-settings";

export function createNativeCoreTransport(
  providers: ProviderRuntimeConfiguration[],
): ReturnType<CoreTransportFactory> {
  const worker = new Worker(
    new URL("../workers/core.worker.ts", import.meta.url),
    {
      type: "module",
      name: "researchbox-core",
    },
  );
  const storageChannel = new MessageChannel();
  const providerChannel = new MessageChannel();
  const pythonChannel = new MessageChannel();
  const webSearchChannel = new MessageChannel();
  const urlReaderChannel = new MessageChannel();
  const storageBroker = createNativeStoragePortBroker(
    storageChannel.port1,
  );
  const providerBroker = createNativeProviderPortBroker(
    providerChannel.port1,
  );
  const pythonBroker = createNativePythonPortBroker(
    pythonChannel.port1,
  );
  const webSearchBroker = createNativeWebSearchPortBroker(
    webSearchChannel.port1,
  );
  const urlReaderBroker = createNativeUrlReaderPortBroker(
    urlReaderChannel.port1,
  );
  const pluginSettings = loadPluginSettings();
  const workerTransport = new WorkerCoreTransport(worker, {
    onClosed() {
      storageBroker.close();
      providerBroker.close();
      pythonBroker.close();
      webSearchBroker.close();
      urlReaderBroker.close();
    },
  });
  const initialization: NativeCoreWorkerInitializeMessage = {
    protocol_version: NATIVE_CORE_WORKER_PROTOCOL_VERSION,
    kind: "native_core_initialize",
    providers,
    storage_port: storageChannel.port2,
    provider_port: providerChannel.port2,
    python_port: pythonChannel.port2,
    web_search_port: webSearchChannel.port2,
    url_reader_port: urlReaderChannel.port2,
    python_plugin: resolvePythonPluginRuntimeConfiguration(
      pluginSettings.plugins.python,
    ),
    web_search_plugin: resolveWebSearchPluginRuntimeConfiguration(
      pluginSettings.plugins["web-search"],
    ),
  };

  try {
    worker.postMessage(initialization, [
      storageChannel.port2,
      providerChannel.port2,
      pythonChannel.port2,
      webSearchChannel.port2,
      urlReaderChannel.port2,
    ]);
  } catch (error) {
    workerTransport.close();
    storageBroker.close();
    providerBroker.close();
    pythonBroker.close();
    webSearchBroker.close();
    urlReaderBroker.close();
    throw error;
  }

  return workerTransport;
}
