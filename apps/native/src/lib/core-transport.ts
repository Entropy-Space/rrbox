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
import { createNativeStoragePortBroker } from "./native-storage-broker.ts";
import {
  NATIVE_CORE_WORKER_PROTOCOL_VERSION,
  type NativeCoreWorkerInitializeMessage,
} from "./types.ts";

export const createNativeCoreTransport: CoreTransportFactory = () => {
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
  const storageBroker = createNativeStoragePortBroker(
    storageChannel.port1,
  );
  const providerBroker = createNativeProviderPortBroker(
    providerChannel.port1,
  );
  const pythonBroker = createNativePythonPortBroker(
    pythonChannel.port1,
  );
  const pluginSettings = loadPluginSettings();
  const workerTransport = new WorkerCoreTransport(worker, {
    onClosed() {
      storageBroker.close();
      providerBroker.close();
      pythonBroker.close();
    },
  });
  const initialization: NativeCoreWorkerInitializeMessage = {
    protocol_version: NATIVE_CORE_WORKER_PROTOCOL_VERSION,
    kind: "native_core_initialize",
    storage_port: storageChannel.port2,
    provider_port: providerChannel.port2,
    python_port: pythonChannel.port2,
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
    ]);
  } catch (error) {
    workerTransport.close();
    storageBroker.close();
    providerBroker.close();
    pythonBroker.close();
    throw error;
  }

  return workerTransport;
};
