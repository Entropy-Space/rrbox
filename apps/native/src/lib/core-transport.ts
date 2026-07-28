import type { CoreTransportFactory } from "@researchbox/client";
import { WorkerCoreTransport } from "@researchbox/runtime-browser";

export const createNativeCoreTransport: CoreTransportFactory = () =>
  new WorkerCoreTransport(
    new Worker(new URL("../workers/core.worker.ts", import.meta.url), {
      type: "module",
      name: "researchbox-core",
    }),
  );
