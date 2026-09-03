import { streamCompatibleModel } from "./ai-sdk-stream.ts";
import {
  parseModelReasoningEfforts,
  parseModelRequest,
  type ModelCatalogTransport,
  type ModelDescriptor,
  type ModelReasoningEffortOption,
  type ModelRequest,
  type ModelStreamEvent,
} from "./model-transport.ts";

export type OpenAiCompatibleModelTransportOptions = {
  provider_id: string;
  provider_display_name: string;
  models_endpoint: string;
  chat_completions_endpoint: string;
  request_headers?: Record<string, string>;
  fetch_request?: typeof fetch;
  /**
   * Send Pi-compatible session-affinity headers on chat completions requests.
   * OpenAI-compatible providers vary in whether they accept these headers, so
   * this must be enabled by the provider composition that opts into them.
   */
  send_session_affinity_headers?: boolean;
  /**
   * Opt in only for endpoints that accept reasoning_content on assistant
   * history messages. Canonical reasoning is retained when this is false.
   */
  send_reasoning_content?: boolean;
};

export class OpenAiCompatibleModelTransport
  implements ModelCatalogTransport
{
  private readonly providerId: string;
  private readonly providerDisplayName: string;
  private readonly modelsEndpoint: string;
  private readonly chatCompletionsEndpoint: string;
  private readonly requestHeaders: Record<string, string>;
  private readonly fetchRequest: typeof fetch;
  private readonly sendSessionAffinityHeaders: boolean;
  private readonly sendReasoningContent: boolean;

  constructor(options: OpenAiCompatibleModelTransportOptions) {
    this.providerId = requireNonEmptyOption(options.provider_id, "provider_id");
    this.providerDisplayName = requireNonEmptyOption(
      options.provider_display_name,
      "provider_display_name",
    );
    this.modelsEndpoint = requireNonEmptyOption(
      options.models_endpoint,
      "models_endpoint",
    );
    this.chatCompletionsEndpoint = requireNonEmptyOption(
      options.chat_completions_endpoint,
      "chat_completions_endpoint",
    );
    this.requestHeaders = { ...options.request_headers };
    this.fetchRequest = (options.fetch_request ?? fetch).bind(globalThis);
    if (
      options.send_session_affinity_headers !== undefined &&
      typeof options.send_session_affinity_headers !== "boolean"
    ) {
      throw new Error("send_session_affinity_headers must be a boolean.");
    }
    this.sendSessionAffinityHeaders =
      options.send_session_affinity_headers ?? false;
    if (
      options.send_reasoning_content !== undefined &&
      typeof options.send_reasoning_content !== "boolean"
    ) {
      throw new Error("send_reasoning_content must be a boolean.");
    }
    this.sendReasoningContent = options.send_reasoning_content ?? false;
  }

  async listModels(signal: AbortSignal): Promise<ModelDescriptor[]> {
    signal.throwIfAborted();
    const response = await this.fetchRequest(this.modelsEndpoint, {
      method: "GET",
      headers: {
        ...this.requestHeaders,
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) {
      throw await createHttpError("Models endpoint", response);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        `Models endpoint returned malformed JSON: ${errorMessage(error)}`,
      );
    }
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error("Models endpoint response must contain a data array.");
    }

    const models = payload.data.map((entry, index) => {
      try {
        return parseCatalogEntry(
          entry,
          this.providerId,
          this.providerDisplayName,
        );
      } catch (error) {
        throw new Error(
          `Invalid model at data[${index}]: ${errorMessage(error)}`,
        );
      }
    });

    return [
      ...new Map(models.map((model) => [model.model_id, model])).values(),
    ].sort((left, right) => left.model_id.localeCompare(right.model_id));
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    signal.throwIfAborted();
    request = parseModelRequest(request);
    if (request.provider_id !== this.providerId) {
      throw new Error(
        `Provider ${request.provider_id} cannot be handled by ${this.providerId}.`,
      );
    }

    yield* streamCompatibleModel(request, signal, {
      endpoint: this.chatCompletionsEndpoint,
      fetch_request: this.fetchRequest,
      headers: {
        ...this.requestHeaders,
        ...(this.sendSessionAffinityHeaders ? {
          session_id: request.session_id,
          "x-client-request-id": request.session_id,
          "x-session-affinity": request.session_id,
        } : {}),
      },
      send_reasoning_content: this.sendReasoningContent,
    });
  }
}

function parseCatalogEntry(
  value: unknown,
  providerId: string,
  providerDisplayName: string,
): ModelDescriptor {
  if (!isRecord(value)) throw new Error("Model entry must be an object.");
  const modelId = readNonEmptyString(value.id);
  if (!modelId) throw new Error("id must be a non-empty string.");

  const metadata = isRecord(value.x_tokn_router)
    ? value.x_tokn_router
    : undefined;
  const capabilities =
    metadata && isRecord(metadata.capabilities)
      ? metadata.capabilities
      : undefined;
  const limit =
    metadata && isRecord(metadata.limit) ? metadata.limit : undefined;
  const supportsReasoning =
    capabilities && typeof capabilities.reasoning === "boolean"
      ? capabilities.reasoning
      : false;
  const reasoningEfforts = parseRouterReasoningEfforts(
    capabilities,
    supportsReasoning,
  );

  return {
    provider_id: providerId,
    ...(metadata?.upstream_provider_id === undefined ? {} : {
      upstream_provider_id: requireUpstreamProviderId(metadata.upstream_provider_id),
    }),
    provider_display_name: providerDisplayName,
    model_id: modelId,
    display_name:
      (metadata && readNonEmptyString(metadata.name)) ??
      readNonEmptyString(value.name) ??
      modelId,
    context_window: readPositiveInteger(limit?.context),
    max_output_tokens: readPositiveInteger(limit?.output),
    supports_tools:
      capabilities && typeof capabilities.toolcall === "boolean"
        ? capabilities.toolcall
        : true,
    supports_reasoning: supportsReasoning,
    supports_reasoning_effort: reasoningEfforts.length > 0,
    reasoning_efforts: reasoningEfforts,
  };
}

function parseRouterReasoningEfforts(
  capabilities: Record<string, unknown> | undefined,
  supportsReasoning: boolean,
): ModelReasoningEffortOption[] {
  const configured = capabilities?.reasoning_efforts;
  // Tokn serializes its Rust Option as null when effort support is unknown.
  if (configured !== undefined && configured !== null) {
    const efforts = parseModelReasoningEfforts(configured);
    if (!supportsReasoning && efforts.length > 0) {
      throw new Error(
        "A non-reasoning model cannot advertise reasoning efforts.",
      );
    }
    return efforts;
  }
  // Reasoning support alone does not imply adjustable effort levels.
  return [];
}

function requireUpstreamProviderId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid upstream_provider_id.");
  }
  return value;
}

async function createHttpError(
  label: string,
  response: Response,
): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.text()).slice(0, 500);
    if (body) {
      try {
        const value = JSON.parse(body) as unknown;
        detail = readApiError(value) ?? body;
      } catch {
        detail = body;
      }
    }
  } catch {
    // The status code still gives the caller a useful error.
  }
  return new Error(
    `${label} returned ${response.status}${detail ? `: ${detail}` : "."}`,
  );
}

function readApiError(value: unknown): string | undefined {
  if (!isRecord(value) || value.error === undefined) return undefined;
  if (typeof value.error === "string") return value.error;
  if (isRecord(value.error)) {
    return (
      readNonEmptyString(value.error.message) ??
      readNonEmptyString(value.error.code) ??
      "Unknown API error."
    );
  }
  return String(value.error);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function requireNonEmptyOption(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
