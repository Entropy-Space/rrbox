/// <reference lib="webworker" />

import type { LlmWorkerHost } from "@researchbox/runtime-browser";
import { attachNativeMockLlmWorker } from "../runtime/native-mock-llm.ts";

attachNativeMockLlmWorker(self as unknown as LlmWorkerHost);

export {};
