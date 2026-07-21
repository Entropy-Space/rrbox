/// <reference lib="webworker" />

import { HttpNdjsonModelTransport } from "@researchbox/model-transport";
import { attachLlmWorkerHost, type LlmWorkerHost } from "@researchbox/runtime-browser";

const host = self as unknown as LlmWorkerHost;

attachLlmWorkerHost(host, new HttpNdjsonModelTransport("/api/mock"));

export {};
