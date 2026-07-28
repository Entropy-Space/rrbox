/// <reference lib="webworker" />

import type { LlmWorkerHost } from "@researchbox/runtime-browser";
import {
  parseNativeLlmWorkerInitializeMessage,
} from "../lib/types.ts";
import { attachNativeLlmWorker } from "../runtime/native-llm.ts";

const host = self as unknown as LlmWorkerHost;

host.onmessage = (event) => {
  const initialization = parseNativeLlmWorkerInitializeMessage(
    event.data,
  );
  attachNativeLlmWorker(host, initialization.provider_port);
};

export {};
