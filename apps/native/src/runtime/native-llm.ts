import {
  NATIVE_OPENAI_PROVIDER_ID,
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

export function attachNativeLlmWorker(
  host: LlmWorkerHost,
  providerEndpoint: NativeProviderRpcEndpoint,
): { close(): void } {
  const providerClient = new NativeProviderRpcClient(providerEndpoint);
  const mockTransport = new HttpNdjsonModelTransport(
    IN_PROCESS_MOCK_MODEL_ENDPOINT,
    createInProcessFetch(),
  );
  const localOpenAiTransport =
    new NativeOpenAiCompatibleModelTransport(providerClient);
  const transports = new Map<string, ModelTransport>([
    [nativeMockModel.provider_id, mockTransport],
    [NATIVE_OPENAI_PROVIDER_ID, localOpenAiTransport],
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
      if (providerId === NATIVE_OPENAI_PROVIDER_ID) {
        return localOpenAiTransport.listModels(signal);
      }
      throw new Error(`Unknown model provider: ${providerId}`);
    },
  });

  return {
    close() {
      attachment.close();
      providerClient.close();
    },
  };
}
