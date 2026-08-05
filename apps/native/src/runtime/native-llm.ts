import {
  NativeOpenAiCompatibleModelTransport,
  NativeProviderRpcClient,
  type NativeProviderRpcEndpoint,
} from "@researchbox/provider-native";
import {
  HttpNdjsonModelTransport,
  type ModelDescriptor,
  type ModelTransport,
} from "@researchbox/model-transport";
import {
  attachLlmWorkerHost,
  type LlmWorkerHost,
} from "@researchbox/runtime-browser";
import {
  createInProcessFetch,
  IN_PROCESS_MOCK_MODEL_ENDPOINT,
  nativeMockModel,
} from "./native-mock-llm.ts";
import type { ProviderRuntimeConfiguration } from "@researchbox/provider-settings";

export function attachNativeLlmWorker(
  host: LlmWorkerHost,
  providerEndpoint: NativeProviderRpcEndpoint,
  providers: readonly ProviderRuntimeConfiguration[],
): { close(): void } {
  const providerClient = new NativeProviderRpcClient(providerEndpoint);
  const mockTransport = new HttpNdjsonModelTransport(
    IN_PROCESS_MOCK_MODEL_ENDPOINT,
    createInProcessFetch(),
  );
  const providerTransports = new Map(
    providers.map((provider) => [
      provider.provider_id,
      new NativeOpenAiCompatibleModelTransport(
        providerClient,
        provider,
      ),
    ]),
  );
  const transports = new Map<string, ModelTransport>([
    [nativeMockModel.provider_id, mockTransport],
    ...providerTransports,
  ]);
  const transport: ModelTransport = {
    stream(request, signal) {
      const selected = transports.get(request.provider_id);
      if (!selected) {
        throw new Error(
          `Unknown model provider: ${request.provider_id}`,
        );
      }
      return selected.stream(request, signal);
    },
  };
  const attachment = attachLlmWorkerHost(host, transport, {
    async listModels(
      providerId: string,
      signal: AbortSignal,
    ): Promise<ModelDescriptor[]> {
      if (providerId === nativeMockModel.provider_id) {
        signal.throwIfAborted();
        return [nativeMockModel];
      }
      const provider = providerTransports.get(providerId);
      if (!provider) {
        throw new Error(`Unknown model provider: ${providerId}`);
      }
      return provider.listModels(signal);
    },
  });

  return {
    close() {
      attachment.close();
      providerClient.close();
    },
  };
}
