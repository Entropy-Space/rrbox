import type {
  ModelSelection,
  ModelSummary,
  ProviderSummary,
  ReasoningEffort,
} from "@researchbox/protocol";
import {
  buildComposerReasoningSuggestions,
  formatReasoningEffort,
  type ComposerReasoningSuggestion,
} from "./composer-commands.ts";
import { modelProviderGroups, modelSelectionPath, selectedProviderGroup, type ModelProviderGroup } from "./model-provider-groups.ts";

export type ComposerModelAvailability =
  | "loading"
  | "pending"
  | "ready"
  | "unavailable";

export type ComposerModelControlSnapshot = {
  model_path: string;
  model_status: string;
  model_availability: ComposerModelAvailability;
  selected_provider?: ModelProviderGroup;
  selected_model?: ModelSummary;
  effort_options: ComposerReasoningSuggestion[];
};

export function buildComposerModelControlSnapshot(
  providers: readonly ProviderSummary[],
  selection: ModelSelection,
  effort: ReasoningEffort,
): ComposerModelControlSnapshot {
  const selectedProvider = selectedProviderGroup(modelProviderGroups(providers), selection);
  const selectedModel = selectedProvider?.models.find(
    (model) => model.model_id === selection.model_id,
  );
  const selectionPending =
    selection.provider_id.length === 0 || selection.model_id.length === 0;
  const catalogIsLoading = providers.some(
    (provider) => provider.availability === "loading",
  );
  const modelAvailability: ComposerModelAvailability = selectionPending
    ? catalogIsLoading
      ? "loading"
      : "pending"
    : !selectedProvider
      ? "unavailable"
      : selectedProvider.availability === "loading"
        ? "loading"
        : selectedProvider.availability === "unavailable" ||
            selectedModel?.availability === "unavailable"
          ? "unavailable"
          : selectedModel
            ? "ready"
            : "unavailable";
  const modelStatus = selectionPending
    ? "Workspace model selection pending"
    : modelAvailability === "loading"
      ? "Loading model"
      : modelAvailability === "unavailable"
        ? "Model unavailable"
        : "Model ready";
  const modelPath = selectionPending
    ? catalogIsLoading
      ? "Discovering models"
      : "Select a model"
    : modelSelectionPath(selectedProvider, selection);

  return {
    model_path: modelPath,
    model_status: modelStatus,
    model_availability: modelAvailability,
    selected_provider: selectedProvider,
    selected_model: selectedModel,
    effort_options: buildComposerReasoningSuggestions(
      providers,
      selection,
      effort,
      "",
    ),
  };
}

export function quickModelsForProvider(
  provider: ProviderSummary | undefined,
): ModelSummary[] {
  if (provider?.availability !== "ready") return [];
  return provider.models.filter((model) => model.availability === "ready");
}

export function formatComposerEffortLabel(
  effort: ReasoningEffort,
  options: readonly ComposerReasoningSuggestion[] = [],
): string {
  return options.find((option) => option.suggestionId === effort)?.label
    ?? formatReasoningEffort(effort);
}

export function reasoningSliderIndex(
  options: readonly ComposerReasoningSuggestion[],
  effort: ReasoningEffort,
): number {
  const index = options.findIndex(
    (option) => option.suggestionId === effort,
  );
  return index < 0 ? 0 : index;
}
