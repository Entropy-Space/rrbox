/// <reference lib="webworker" />

import {
  HttpNdjsonModelTransport,
  OpenAiCompatibleModelTransport,
  type ModelDescriptor,
  type ModelTransport,
} from "@researchbox/model-transport";
import { attachLlmWorkerHost, type LlmWorkerHost } from "@researchbox/runtime-browser";
import { researchBoxMockModel } from "./mock-model";

const host = self as unknown as LlmWorkerHost;
const mockTransport = new HttpNdjsonModelTransport("/api/mock");
const localOpenAiTransport = new OpenAiCompatibleModelTransport({
  provider_id: "local-openai",
  provider_display_name: "OpenAI-compatible · localhost:4141",
  models_endpoint: "/api/providers/local-openai/models",
  chat_completions_endpoint:
    "/api/providers/local-openai/chat/completions",
  request_headers: { "x-researchbox-provider": "local-openai" },
});
const transports = new Map<string, ModelTransport>([
  [researchBoxMockModel.provider, mockTransport],
  ["local-openai", localOpenAiTransport],
]);
const transport: ModelTransport = {
  stream(request, signal) {
    const provider = transports.get(request.provider_id);
    if (!provider) {
      throw new Error(`Unknown model provider: ${request.provider_id}`);
    }
    return provider.stream(request, signal);
  },
};

attachLlmWorkerHost(host, transport, {
  async listModels(
    providerId: string,
    signal: AbortSignal,
  ): Promise<ModelDescriptor[]> {
    if (providerId === researchBoxMockModel.provider) {
      return [
        {
          provider_id: researchBoxMockModel.provider,
          provider_display_name: "ResearchBox",
          model_id: researchBoxMockModel.id,
          display_name: researchBoxMockModel.name,
          context_window: researchBoxMockModel.contextWindow,
          max_output_tokens: researchBoxMockModel.maxTokens,
          supports_tools: true,
          supports_reasoning: false,
        },
      ];
    }
    if (providerId === "local-openai") {
      return localOpenAiTransport.listModels(signal);
    }
    throw new Error(`Unknown model provider: ${providerId}`);
  },
});

export {};
