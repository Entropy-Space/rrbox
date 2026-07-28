import {
  OpenAiCompatibleModelTransport,
  type ModelCatalogTransport,
  type ModelDescriptor,
  type ModelRequest,
  type ModelStreamEvent,
} from "@researchbox/model-transport";
import {
  NATIVE_PROVIDER_CHAT_COMPLETIONS_URL,
  NATIVE_PROVIDER_MODELS_URL,
  type NativeProviderRpcClient,
} from "./rpc-client.ts";
import { NATIVE_OPENAI_PROVIDER_ID } from "./wire-types.ts";

export const NATIVE_OPENAI_PROVIDER_DISPLAY_NAME =
  "OpenAI-compatible · localhost:4141";

export class NativeOpenAiCompatibleModelTransport
  implements ModelCatalogTransport
{
  private readonly transport: OpenAiCompatibleModelTransport;

  constructor(client: Pick<NativeProviderRpcClient, "fetch_request">) {
    this.transport = new OpenAiCompatibleModelTransport({
      provider_id: NATIVE_OPENAI_PROVIDER_ID,
      provider_display_name: NATIVE_OPENAI_PROVIDER_DISPLAY_NAME,
      models_endpoint: NATIVE_PROVIDER_MODELS_URL,
      chat_completions_endpoint:
        NATIVE_PROVIDER_CHAT_COMPLETIONS_URL,
      fetch_request: client.fetch_request,
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
