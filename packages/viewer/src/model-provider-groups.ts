import type { ModelSelection, ProviderSummary } from "@researchbox/protocol";

/** A picker row, not a new routing provider or a persisted selection. */
export type ModelProviderGroup = ProviderSummary & {
  group_id: string;
  upstream_provider_id?: string;
};

export function modelProviderGroups(
  providers: readonly ProviderSummary[],
): ModelProviderGroup[] {
  return providers.flatMap((provider) => {
    const fallback = { ...provider, group_id: JSON.stringify([provider.provider_id]) };
    if (provider.kind !== "tokn" || !provider.upstream_providers?.length) {
      return [fallback];
    }
    const remaining = new Set(provider.models);
    const groups: ModelProviderGroup[] = provider.upstream_providers.map((upstream) => {
      const models = provider.models.filter((model) => {
        const belongs = model.upstream_provider_id === upstream.provider_id ||
          (model.upstream_provider_id === undefined && model.model_id.startsWith(`${upstream.provider_id}/`));
        if (belongs) remaining.delete(model);
        return belongs;
      });
      return {
        ...provider,
        group_id: JSON.stringify([provider.provider_id, upstream.provider_id]),
        upstream_provider_id: upstream.provider_id,
        display_name: upstream.display_name,
        models,
      };
    });
    // Advanced aliases and unavailable saved models retain their routing IDs.
    if (remaining.size > 0) {
      groups.push({ ...fallback, display_name: "Tokn routes", models: [...remaining] });
    }
    return groups;
  });
}

export function selectedProviderGroup(
  groups: readonly ModelProviderGroup[],
  selection: ModelSelection,
): ModelProviderGroup | undefined {
  const candidates = groups.filter((group) => group.provider_id === selection.provider_id);
  return candidates.find((group) => group.models.some((model) => model.model_id === selection.model_id))
    ?? candidates.find((group) => group.upstream_provider_id !== undefined &&
      selection.model_id.startsWith(`${group.upstream_provider_id}/`))
    ?? candidates[0];
}

export function providerKindLabel(provider: ProviderSummary): string {
  if (provider.kind === "mock") return "Built in";
  return provider.kind === "tokn" ? "Tokn" : "OpenAI compatible";
}

export function modelSelectionPath(
  provider: ProviderSummary | undefined,
  selection: ModelSelection,
): string {
  return provider?.kind === "tokn" ? selection.model_id
    : `${selection.provider_id}/${selection.model_id}`;
}
