import type {
  WebSearchExecutor,
  WebSearchProviderId,
  WebSearchProviderFailure,
  WebSearchRequest,
  WebSearchResolvedProviderId,
  WebSearchResponse,
  WebSearchSource,
} from "./web-search-plugin.ts";

export type WebSearchProviderErrorKind =
  | "transient"
  | "quota"
  | "network"
  | "permanent";

export type WebSearchRoutingConfiguration = {
  providers: readonly WebSearchResolvedProviderId[];
  fallback_on: readonly Exclude<
    WebSearchProviderErrorKind,
    "permanent"
  >[];
};

export type WebSearchProvider = {
  id: WebSearchResolvedProviderId;
  is_available?(): boolean | Promise<boolean>;
  search(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse>;
  close(): void | Promise<void>;
};

export class WebSearchProviderError extends Error {
  readonly provider_id: WebSearchResolvedProviderId;
  readonly kind: WebSearchProviderErrorKind;

  constructor(options: {
    provider_id: WebSearchResolvedProviderId;
    kind: WebSearchProviderErrorKind;
    message: string;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "WebSearchProviderError";
    this.provider_id = options.provider_id;
    this.kind = options.kind;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
      });
    }
  }
}

export class WebSearchAggregateError extends Error {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[], message: string) {
    super(message);
    this.name = "WebSearchAggregateError";
    this.errors = [...errors];
  }
}

export class RoutingWebSearchExecutor implements WebSearchExecutor {
  private readonly providers: ReadonlyMap<
    WebSearchResolvedProviderId,
    WebSearchProvider
  >;
  private readonly defaultProvider: WebSearchProviderId;
  private readonly routing: WebSearchRoutingConfiguration;
  private closed = false;

  constructor(options: {
    providers: readonly WebSearchProvider[];
    default_provider: WebSearchProviderId;
    routing?: WebSearchRoutingConfiguration;
  }) {
    if (options.providers.length === 0) {
      throw new Error("At least one web search provider is required.");
    }
    const providers = new Map<
      WebSearchResolvedProviderId,
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
    const routing = options.routing ?? {
      providers: [...providers.keys()],
      fallback_on: ["transient", "quota", "network"],
    };
    validateRoutingConfiguration(routing, providers);
    this.providers = providers;
    this.defaultProvider = options.default_provider;
    this.routing = {
      providers: [...routing.providers],
      fallback_on: [...new Set(routing.fallback_on)],
    };
  }

  async search(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    if (this.closed) {
      throw new Error("The web search executor is closed.");
    }
    throwIfAborted(signal);
    const requested = request.provider === "auto"
      ? this.defaultProvider
      : request.provider;
    if (requested === "all") {
      return this.searchAll(request, signal);
    }
    if (requested !== "auto") {
      const provider = this.providers.get(requested);
      if (!provider || !(await providerIsAvailable(provider))) {
        throw new Error(
          `Web search provider is unavailable: ${requested}`,
        );
      }
      return searchProvider(provider, request, signal);
    }
    return this.searchWithFallback(request, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const outcomes = await Promise.allSettled(
      [...this.providers.values()].map((provider) =>
        Promise.resolve().then(() => provider.close())
      ),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    );
    if (failures.length > 0) {
      throw new WebSearchAggregateError(
        failures,
        "One or more web search providers failed to close.",
      );
    }
  }

  private async searchWithFallback(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const diagnostics: string[] = [];
    for (const providerId of this.routing.providers) {
      throwIfAborted(signal);
      const provider = this.providers.get(providerId)!;
      if (!(await providerIsAvailable(provider))) {
        diagnostics.push(`${providerId}: unavailable`);
        continue;
      }
      try {
        return await searchProvider(provider, request, signal);
      } catch (error) {
        throwIfAborted(signal);
        const classified = classifyProviderError(providerId, error);
        diagnostics.push(
          `${providerId} [${classified.kind}]: ${classified.message}`,
        );
        if (
          classified.kind === "permanent" ||
          !this.routing.fallback_on.includes(classified.kind)
        ) {
          throw classified;
        }
      }
    }
    throw new Error(
      `Web search routing exhausted:\n  - ${diagnostics.join("\n  - ")}`,
    );
  }

  private async searchAll(
    request: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const availability = await Promise.all(
      this.routing.providers.map(async (providerId) => {
        const provider = this.providers.get(providerId)!;
        return {
          provider,
          available: await providerIsAvailable(provider),
        };
      }),
    );
    throwIfAborted(signal);
    const available = availability
      .filter((entry) => entry.available)
      .map((entry) => entry.provider);
    if (available.length === 0) {
      throw new Error("No web search providers are available.");
    }
    const outcomes = await Promise.allSettled(
      available.map((provider) =>
        searchProvider(provider, request, signal)
      ),
    );
    throwIfAborted(signal);
    const responses: WebSearchResponse[] = [];
    const failures: WebSearchProviderError[] = [];
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome.status === "fulfilled") {
        responses.push(outcome.value);
      } else {
        failures.push(
          classifyProviderError(available[index].id, outcome.reason),
        );
      }
    }
    if (responses.length === 0) {
      throw new WebSearchAggregateError(
        failures,
        `All-provider web search failed:\n  - ${
          failures.map(formatProviderFailure).join("\n  - ")
        }`,
      );
    }
    return combineProviderResponses(request, responses, failures);
  }
}

function validateRoutingConfiguration(
  routing: WebSearchRoutingConfiguration,
  providers: ReadonlyMap<WebSearchResolvedProviderId, WebSearchProvider>,
): void {
  if (routing.providers.length === 0) {
    throw new Error("Web search routing requires at least one provider.");
  }
  const providerIds = new Set<WebSearchResolvedProviderId>();
  for (const providerId of routing.providers) {
    if (providerIds.has(providerId)) {
      throw new Error(
        `Duplicate routed web search provider: ${providerId}`,
      );
    }
    if (!providers.has(providerId)) {
      throw new Error(
        `Unavailable routed web search provider: ${providerId}`,
      );
    }
    providerIds.add(providerId);
  }
  const validKinds = new Set<WebSearchProviderErrorKind>([
    "transient",
    "quota",
    "network",
  ]);
  if (
    routing.fallback_on.length === 0 ||
    routing.fallback_on.some((kind) => !validKinds.has(kind))
  ) {
    throw new Error(
      "Web search fallback kinds must include transient, quota, or network.",
    );
  }
}

async function providerIsAvailable(
  provider: WebSearchProvider,
): Promise<boolean> {
  try {
    return provider.is_available
      ? await provider.is_available()
      : true;
  } catch {
    return false;
  }
}

async function searchProvider(
  provider: WebSearchProvider,
  request: WebSearchRequest,
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  return provider.search({
    ...request,
    provider: provider.id,
  }, signal);
}

export function classifyProviderError(
  providerId: WebSearchResolvedProviderId,
  error: unknown,
): WebSearchProviderError {
  if (error instanceof WebSearchProviderError) return error;
  const message = error instanceof Error
    ? error.message
    : "Unknown provider failure.";
  const normalized = message.toLowerCase();
  let kind: WebSearchProviderErrorKind = "permanent";
  if (
    normalized.includes("429") ||
    normalized.includes("402") ||
    normalized.includes("rate limit") ||
    normalized.includes("quota")
  ) {
    kind = "quota";
  } else if (
    normalized.includes("network") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("connection") ||
    normalized.includes("dns")
  ) {
    kind = "network";
  } else if (
    normalized.includes("408") ||
    normalized.includes("425") ||
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("timeout") ||
    normalized.includes("temporar")
  ) {
    kind = "transient";
  }
  return new WebSearchProviderError({
    provider_id: providerId,
    kind,
    message,
    cause: error,
  });
}

function combineProviderResponses(
  request: WebSearchRequest,
  responses: WebSearchResponse[],
  failures: WebSearchProviderError[],
): WebSearchResponse {
  const sources: WebSearchSource[] = [];
  const seenUrls = new Set<string>();
  const sourceIndices = responses.map(() => 0);
  while (sources.length < request.num_results) {
    let added = false;
    for (let index = 0; index < responses.length; index += 1) {
      const providerSources = responses[index].sources;
      while (sourceIndices[index] < providerSources.length) {
        const source = providerSources[sourceIndices[index]];
        sourceIndices[index] += 1;
        if (seenUrls.has(source.url)) continue;
        seenUrls.add(source.url);
        sources.push(source);
        added = true;
        break;
      }
      if (sources.length === request.num_results) break;
    }
    if (!added) break;
  }
  const answerSections = responses.map((response) =>
    `## ${providerLabel(response.provider)}\n\n${
      response.answer || "(No answer text returned.)"
    }`
  );
  if (failures.length > 0) {
    answerSections.push(
      `## Provider errors\n\n${
        failures.map((failure) =>
          `- **${providerLabel(failure.provider_id)}:** ${failure.message}`
        ).join("\n")
      }`,
    );
  }
  return {
    query: request.query,
    provider: "all",
    answer: answerSections.join("\n\n"),
    sources,
    provider_responses: [...responses],
    provider_errors: failures.map((failure): WebSearchProviderFailure => ({
      provider: failure.provider_id,
      error: failure.message,
    })),
  };
}

function providerLabel(
  providerId: Exclude<WebSearchProviderId, "auto">,
): string {
  if (providerId === "anysearch") return "AnySearch";
  return providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

function formatProviderFailure(error: WebSearchProviderError): string {
  return `${providerLabel(error.provider_id)} [${error.kind}]: ${error.message}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Web search was cancelled.", "AbortError");
  }
}
