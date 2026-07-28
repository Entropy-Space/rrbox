import type {
  WebSearchExecutor,
  WebSearchProviderId,
  WebSearchRequest,
  WebSearchResponse,
} from "./web-search-plugin.ts";

export type WebSearchProvider = {
  id: Exclude<WebSearchProviderId, "auto">;
  search(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse>;
  close(): void | Promise<void>;
};

export class RoutingWebSearchExecutor implements WebSearchExecutor {
  private readonly providers: ReadonlyMap<
    Exclude<WebSearchProviderId, "auto">,
    WebSearchProvider
  >;
  private readonly defaultProvider: WebSearchProviderId;
  private closed = false;

  constructor(options: {
    providers: readonly WebSearchProvider[];
    default_provider: WebSearchProviderId;
  }) {
    if (options.providers.length === 0) {
      throw new Error("At least one web search provider is required.");
    }
    const providers = new Map<
      Exclude<WebSearchProviderId, "auto">,
      WebSearchProvider
    >();
    for (const provider of options.providers) {
      if (providers.has(provider.id)) {
        throw new Error(
          `Duplicate web search provider: ${provider.id}`,
        );
      }
      providers.set(provider.id, provider);
    }
    if (
      options.default_provider !== "auto" &&
      !providers.has(options.default_provider)
    ) {
      throw new Error(
        `Unavailable default web search provider: ${options.default_provider}`,
      );
    }
    this.providers = providers;
    this.defaultProvider = options.default_provider;
  }

  async search(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    if (this.closed) {
      throw new Error("The web search executor is closed.");
    }
    const requested = request.provider === "auto"
      ? this.defaultProvider
      : request.provider;
    const provider = requested === "auto"
      ? this.providers.values().next().value
      : this.providers.get(requested);
    if (!provider) {
      throw new Error(
        `Web search provider is unavailable: ${request.provider}`,
      );
    }
    return provider.search({
      ...request,
      provider: provider.id,
    }, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      [...this.providers.values()].map((provider) => provider.close()),
    );
  }
}
