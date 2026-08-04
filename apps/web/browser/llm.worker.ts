/// <reference lib="webworker" />

import {
  HttpNdjsonModelTransport,
  OpenAiCompatibleModelTransport,
  type ModelDescriptor,
  type ModelTransport,
} from "@researchbox/model-transport";
import { attachLlmWorkerHost, type LlmWorkerHost } from "@researchbox/runtime-browser";
import {
  researchBoxMockModel,
  researchBoxMockModelDescriptor,
} from "@researchbox/app-runtime-browser/mock-model";
import { providerEndpoint } from "@researchbox/provider-settings";
import {
  parseWebLlmWorkerInitializeMessage,
} from "./core-worker-initialization.ts";

const host = self as unknown as LlmWorkerHost;
host.onmessage = (event) => {
  const initialization = parseWebLlmWorkerInitializeMessage(event.data);
  const mockTransport = new HttpNdjsonModelTransport("/api/mock");
  const catalogTransports = new Map(
    initialization.providers.map((provider) => [
      provider.provider_id,
      new OpenAiCompatibleModelTransport({
        provider_id: provider.provider_id,
        provider_display_name: provider.display_name,
        models_endpoint: providerEndpoint(provider.base_url, "models"),
        chat_completions_endpoint: providerEndpoint(
          provider.base_url,
          "chat_completions",
        ),
        request_headers: provider.api_key
          ? { authorization: `Bearer ${provider.api_key}` }
          : {},
        send_session_affinity_headers:
          provider.send_session_affinity_headers,
        send_reasoning_content: provider.send_reasoning_content,
      }),
    ]),
  );
  const transports = new Map<string, ModelTransport>([
    [researchBoxMockModel.provider, mockTransport],
    ...catalogTransports,
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
        return [researchBoxMockModelDescriptor];
      }
      const provider = catalogTransports.get(providerId);
      if (!provider) {
        throw new Error(`Unknown model provider: ${providerId}`);
      }
      return provider.listModels(signal);
    },
  });
};

export {};
