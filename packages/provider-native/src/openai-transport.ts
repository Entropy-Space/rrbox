import {
  OpenAiCompatibleModelTransport,
  type ModelCatalogTransport,
  type ModelDescriptor,
  type ModelRequest,
  type ModelStreamEvent,
} from "@researchbox/model-transport";
import type { ProviderRuntimeConfiguration } from "@researchbox/provider-settings";
import {
  NATIVE_PROVIDER_CHAT_COMPLETIONS_URL,
  NATIVE_PROVIDER_MODELS_URL,
  type NativeProviderRpcClient,
} from "./rpc-client.ts";

export const NATIVE_OPENAI_PROVIDER_DISPLAY_NAME =
  "OpenAI-compatible · localhost:4141";

export class NativeOpenAiCompatibleModelTransport
  implements ModelCatalogTransport
{
  private readonly transport: OpenAiCompatibleModelTransport;

  constructor(
    client: Pick<NativeProviderRpcClient, "create_fetch_request">,
    provider: ProviderRuntimeConfiguration,
  ) {
    this.transport = new OpenAiCompatibleModelTransport({
      provider_id: provider.provider_id,
      provider_display_name: provider.display_name,
      models_endpoint: NATIVE_PROVIDER_MODELS_URL,
      chat_completions_endpoint:
        NATIVE_PROVIDER_CHAT_COMPLETIONS_URL,
      fetch_request: client.create_fetch_request(provider.provider_id),
      send_session_affinity_headers:
        provider.send_session_affinity_headers,
      send_reasoning_content: provider.send_reasoning_content,
    });
  }

  listModels(signal: AbortSignal): Promise<ModelDescriptor[]> {
    return this.transport.listModels(signal);
  }

  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    return this.transport.stream(request, signal);
  }
}
