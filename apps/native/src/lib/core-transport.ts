import type { CoreTransportFactory } from "@researchbox/client";
import { WorkerCoreTransport } from "@researchbox/runtime-browser";
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
  const storageBroker = createNativeStoragePortBroker(
    storageChannel.port1,
  );
  const workerTransport = new WorkerCoreTransport(worker, {
    onClosed() {
      storageBroker.close();
    },
  });
  const initialization: NativeCoreWorkerInitializeMessage = {
    protocol_version: NATIVE_CORE_WORKER_PROTOCOL_VERSION,
    kind: "native_core_initialize",
    storage_port: storageChannel.port2,
  };

  try {
    worker.postMessage(initialization, [storageChannel.port2]);
  } catch (error) {
    workerTransport.close();
    storageBroker.close();
    throw error;
  }

  return workerTransport;
};
