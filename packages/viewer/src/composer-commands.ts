import {
  reasoningEffortDisplayName,
  type ModelSelection,
  type ProviderSummary,
  type ReasoningEffort,
} from "@researchbox/protocol";
import { modelProviderGroups } from "./model-provider-groups.ts";

export type ComposerCommandId = "model" | "reasoning";

export type ComposerCommand = {
  commandId: ComposerCommandId;
  invocation: string;
  title: string;
  description: string;
};

export type ComposerModelSuggestion = {
  suggestionId: string;
  providerId: string;
  modelId: string;
  providerTitle: string;
  title: string;
  description: string;
  isSelected: boolean;
};

export type ComposerReasoningSuggestion = {
  suggestionId: ReasoningEffort;
  label: string;
  title: string;
  description: string;
  isSelected: boolean;
};

export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  {
    commandId: "model",
    invocation: "/model",
    title: "Switch model",
    description: "Choose the model for this chat.",
  },
  {
    commandId: "reasoning",
    invocation: "/reasoning",
    title: "Reasoning effort",
    description: "Choose how much reasoning to use in this chat.",
  },
];

export function matchComposerCommands(
  draft: string,
): readonly ComposerCommand[] {
  if (!draft.startsWith("/") || /\s/u.test(draft)) return [];
  const query = draft.slice(1).toLocaleLowerCase();
  return COMPOSER_COMMANDS.filter((command) =>
    command.invocation.slice(1).toLocaleLowerCase().startsWith(query)
  );
}

export function modelCommandQuery(draft: string): string | null {
  return composerCommandQuery(draft, "model");
}

export function composerCommandQuery(
  draft: string,
  commandId: ComposerCommandId,
): string | null {
  const command = COMPOSER_COMMANDS.find(
    (candidate) => candidate.commandId === commandId,
  );
  if (!command) return null;
  const prefix = `${command.invocation} `;
  return draft.startsWith(prefix) ? draft.slice(prefix.length) : null;
}

export function buildComposerModelSuggestions(
  providers: readonly ProviderSummary[],
  selection: ModelSelection,
  query: string,
): ComposerModelSuggestion[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return modelProviderGroups(providers).flatMap((provider) => {
    if (provider.availability !== "ready") return [];
    return provider.models.flatMap((model) => {
      if (model.availability !== "ready") return [];
      const searchText = [
        provider.display_name,
        provider.provider_id,
        model.display_name,
        model.model_id,
      ].join(" ").toLocaleLowerCase();
      if (normalizedQuery && !searchText.includes(normalizedQuery)) {
        return [];
      }
      return [{
        suggestionId: `${provider.provider_id}\u0000${model.model_id}`,
        providerId: provider.provider_id,
        modelId: model.model_id,
        providerTitle: provider.display_name,
        title: model.display_name,
        description: model.display_name === model.model_id
          ? "Available model"
          : model.model_id,
        isSelected:
          provider.provider_id === selection.provider_id &&
          model.model_id === selection.model_id,
      }];
    });
  });
}

export function buildComposerReasoningSuggestions(
  providers: readonly ProviderSummary[],
  selection: ModelSelection,
  activeEffort: ReasoningEffort,
  query: string,
): ComposerReasoningSuggestion[] {
  const activeModel = providers
    .find((provider) => provider.provider_id === selection.provider_id)
    ?.models.find((model) => model.model_id === selection.model_id);
  const availableEfforts: Omit<ComposerReasoningSuggestion, "isSelected">[] = [
    {
      suggestionId: "default",
      label: "Auto",
      title: "Provider default",
      description: "Let the selected model choose its reasoning effort.",
    },
    ...(activeModel?.reasoning_efforts ?? []).map((option) => ({
      suggestionId: option.id,
      label: option.display_name,
      title: option.display_name,
      description: option.description ?? `Use ${option.display_name} reasoning effort.`,
    })),
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return availableEfforts
    .filter((suggestion) => {
      if (!normalizedQuery) return true;
      return [
        suggestion.suggestionId,
        suggestion.title,
        suggestion.description,
      ].join(" ").toLocaleLowerCase().includes(normalizedQuery);
    })
    .map((suggestion) => ({
      ...suggestion,
      isSelected: suggestion.suggestionId === activeEffort,
    }));
}

export function formatReasoningEffort(effort: ReasoningEffort): string {
  return effort === "default" ? "Auto" : reasoningEffortDisplayName(effort);
}

export function moveComposerSuggestion(
  currentIndex: number,
  itemCount: number,
  offset: -1 | 1,
): number {
  if (itemCount === 0) return -1;
  const normalizedIndex = currentIndex < 0 || currentIndex >= itemCount
    ? 0
    : currentIndex;
  return (normalizedIndex + offset + itemCount) % itemCount;
}

export function isImeCommitKey({
  key,
  keyCode,
  nativeIsComposing,
  compositionIsActive,
  lastCompositionEndAt,
  now,
}: {
  key: string;
  keyCode: number;
  nativeIsComposing: boolean;
  compositionIsActive: boolean;
  lastCompositionEndAt: number;
  now: number;
}): boolean {
  if (key !== "Enter") return false;
  return nativeIsComposing ||
    compositionIsActive ||
    keyCode === 229 ||
    now - lastCompositionEndAt < 100;
}
