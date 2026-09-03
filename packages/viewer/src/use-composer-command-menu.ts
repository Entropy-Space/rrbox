import type {
  ModelSelection,
  ProviderSummary,
  ReasoningEffort,
} from "@researchbox/protocol";
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  buildComposerModelSuggestions,
  buildComposerReasoningSuggestions,
  composerCommandQuery,
  isImeCommitKey,
  matchComposerCommands,
  moveComposerSuggestion,
  type ComposerCommandId,
} from "./composer-commands.ts";
import {
  composerCommandOptionId,
  type ComposerCommandMenuItem,
} from "./ComposerCommandMenu.tsx";

export type ComposerCommandMenuView = {
  menuId: string;
  label: string;
  items: readonly ComposerCommandMenuItem[];
  activeIndex: number;
  emptyMessage: string | null;
};

export type ComposerCommandKeyResult = "handled" | "ime" | "unhandled";

export type UseComposerCommandMenuOptions = {
  draft: string;
  draftScope: string;
  providers: readonly ProviderSummary[];
  selection: ModelSelection;
  activeReasoningEffort: ReasoningEffort;
  canSelectModel: boolean;
  canSelectReasoningEffort: boolean;
  onDraftChange: (draft: string) => void;
  onSelectModel: (providerId: string, modelId: string) => void;
  onSelectReasoningEffort: (reasoningEffort: ReasoningEffort) => void;
  focusComposer: () => void;
};

type ComposerInteractionState = {
  draftScope: string;
  acceptedCommandId: ComposerCommandId | null;
  dismissedDraft: string | null;
  activeIndex: number;
};

type ComposerInteractionUpdate = Partial<
  Omit<ComposerInteractionState, "draftScope">
>;

function createComposerInteractionState(
  draftScope: string,
): ComposerInteractionState {
  return {
    draftScope,
    acceptedCommandId: null,
    dismissedDraft: null,
    activeIndex: 0,
  };
}

export function useComposerCommandMenu({
  draft,
  draftScope,
  providers,
  selection,
  activeReasoningEffort,
  canSelectModel,
  canSelectReasoningEffort,
  onDraftChange,
  onSelectModel,
  onSelectReasoningEffort,
  focusComposer,
}: UseComposerCommandMenuOptions) {
  const menuId = useId();
  const [storedInteraction, setStoredInteraction] = useState(
    () => createComposerInteractionState(draftScope),
  );
  const [isFocused, setIsFocused] = useState(false);
  const compositionIsActiveRef = useRef(false);
  const lastCompositionEndAtRef = useRef(Number.NEGATIVE_INFINITY);
  const interaction = storedInteraction.draftScope === draftScope
    ? storedInteraction
    : createComposerInteractionState(draftScope);
  const updateInteraction = useCallback((
    update: ComposerInteractionUpdate | (
      (current: ComposerInteractionState) => ComposerInteractionUpdate
    ),
  ) => {
    setStoredInteraction((stored) => {
      const current = stored.draftScope === draftScope
        ? stored
        : createComposerInteractionState(draftScope);
      const resolvedUpdate = typeof update === "function"
        ? update(current)
        : update;
      return { ...current, ...resolvedUpdate };
    });
  }, [draftScope]);
  const {
    acceptedCommandId,
    dismissedDraft,
    activeIndex,
  } = interaction;

  const acceptedCommandQuery = acceptedCommandId === null
    ? null
    : composerCommandQuery(draft, acceptedCommandId);
  const isCommandAccepted = acceptedCommandQuery !== null;
  const acceptedModelQuery = acceptedCommandId === "model"
    ? acceptedCommandQuery
    : null;
  const acceptedReasoningQuery = acceptedCommandId === "reasoning"
    ? acceptedCommandQuery
    : null;
  const matchingCommands = useMemo(
    () => matchComposerCommands(draft),
    [draft],
  );
  const modelSuggestions = useMemo(
    () => acceptedModelQuery !== null && canSelectModel
      ? buildComposerModelSuggestions(
          providers,
          selection,
          acceptedModelQuery,
        )
      : [],
    [
      acceptedModelQuery,
      canSelectModel,
      providers,
      selection,
    ],
  );
  const reasoningSuggestions = useMemo(
    () => acceptedReasoningQuery !== null && canSelectReasoningEffort
      ? buildComposerReasoningSuggestions(
          providers,
          selection,
          activeReasoningEffort,
          acceptedReasoningQuery,
        )
      : [],
    [
      acceptedReasoningQuery,
      activeReasoningEffort,
      canSelectReasoningEffort,
      providers,
      selection,
    ],
  );
  const menuIsDismissed = dismissedDraft === draft;
  const commandMenuIsVisible =
    isFocused &&
    !menuIsDismissed &&
    !isCommandAccepted &&
    matchingCommands.length > 0;
  const actionMenuIsVisible =
    isFocused &&
    !menuIsDismissed &&
    isCommandAccepted;

  const commandItems = useMemo<readonly ComposerCommandMenuItem[]>(
    () => matchingCommands.map((command) => ({
      itemId: command.commandId,
      badge: command.invocation,
      title: command.title,
      description: command.description,
    })),
    [matchingCommands],
  );
  const modelItems = useMemo<readonly ComposerCommandMenuItem[]>(
    () => modelSuggestions.map((model) => ({
      itemId: model.suggestionId,
      badge: model.providerTitle,
      title: model.title,
      description: model.description,
      isCurrent: model.isSelected,
    })),
    [modelSuggestions],
  );
  const reasoningItems = useMemo<readonly ComposerCommandMenuItem[]>(
    () => reasoningSuggestions.map((suggestion) => ({
      itemId: suggestion.suggestionId,
      badge: suggestion.label,
      title: suggestion.title,
      description: suggestion.description,
      isCurrent: suggestion.isSelected,
    })),
    [reasoningSuggestions],
  );
  const actionItems = acceptedCommandId === "reasoning"
    ? reasoningItems
    : modelItems;
  const actionSuggestions = acceptedCommandId === "reasoning"
    ? reasoningSuggestions
    : modelSuggestions;
  const visibleItems = actionMenuIsVisible ? actionItems : commandItems;
  const fallbackIndex = actionMenuIsVisible
    ? Math.max(
        0,
        actionSuggestions.findIndex((suggestion) => suggestion.isSelected),
      )
    : 0;
  const visibleActiveIndex = activeIndex >= 0 && activeIndex < visibleItems.length
    ? activeIndex
    : fallbackIndex;
  const menu = useMemo<ComposerCommandMenuView | null>(
    () => commandMenuIsVisible
      ? {
          menuId,
          label: "Commands",
          items: commandItems,
          activeIndex: visibleActiveIndex,
          emptyMessage: null,
        }
      : actionMenuIsVisible
        ? {
            menuId,
            label: acceptedCommandId === "reasoning"
              ? "Choose reasoning effort"
              : "Choose a model",
            items: actionItems,
            activeIndex: visibleActiveIndex,
            emptyMessage: commandEmptyMessage(
              acceptedCommandId,
              canSelectModel,
              canSelectReasoningEffort,
            ),
          }
        : null,
    [
      canSelectModel,
      canSelectReasoningEffort,
      acceptedCommandId,
      actionItems,
      actionMenuIsVisible,
      commandItems,
      commandMenuIsVisible,
      menuId,
      visibleActiveIndex,
    ],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const nextDraft = event.target.value;
      updateInteraction((current) => ({
        dismissedDraft: null,
        activeIndex: 0,
        acceptedCommandId:
          current.acceptedCommandId === null ||
          composerCommandQuery(nextDraft, current.acceptedCommandId) === null
          ? null
          : current.acceptedCommandId,
      }));
      onDraftChange(nextDraft);
    },
    [onDraftChange, updateInteraction],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): ComposerCommandKeyResult => {
      if (isImeCommitKey({
        key: event.key,
        keyCode: event.nativeEvent.keyCode,
        nativeIsComposing: event.nativeEvent.isComposing,
        compositionIsActive: compositionIsActiveRef.current,
        lastCompositionEndAt: lastCompositionEndAtRef.current,
        now: Date.now(),
      })) {
        return "ime";
      }

      const visibleMenu = menu;
      if (!visibleMenu) return "unhandled";

      if (event.key === "Escape") {
        event.preventDefault();
        updateInteraction({
          dismissedDraft: draft,
          acceptedCommandId: null,
        });
        return "handled";
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        updateInteraction({
          activeIndex: moveComposerSuggestion(
            visibleMenu.activeIndex,
            visibleMenu.items.length,
            event.key === "ArrowDown" ? 1 : -1,
          ),
        });
        return "handled";
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        updateInteraction({
          activeIndex:
            event.key === "Home" ? 0 : visibleMenu.items.length - 1,
        });
        return "handled";
      }
      if (
        (event.key !== "Enter" || event.shiftKey) &&
        (event.key !== "Tab" || event.shiftKey)
      ) {
        return "unhandled";
      }

      event.preventDefault();
      const selectedIndex = visibleMenu.activeIndex;
      if (commandMenuIsVisible) {
        const command = matchingCommands[selectedIndex];
        if (!command) return "handled";
        updateInteraction({
          acceptedCommandId: command.commandId,
          dismissedDraft: null,
          activeIndex: -1,
        });
        onDraftChange(`${command.invocation} `);
        return "handled";
      }

      if (acceptedCommandId === "reasoning") {
        const suggestion = reasoningSuggestions[selectedIndex];
        if (!suggestion || !canSelectReasoningEffort) return "handled";
        if (!suggestion.isSelected) {
          onSelectReasoningEffort(suggestion.suggestionId);
        }
      } else {
        const model = modelSuggestions[selectedIndex];
        if (!model || !canSelectModel) return "handled";
        if (!model.isSelected) {
          onSelectModel(model.providerId, model.modelId);
        }
      }
      updateInteraction({
        acceptedCommandId: null,
        dismissedDraft: null,
        activeIndex: 0,
      });
      onDraftChange("");
      requestAnimationFrame(focusComposer);
      return "handled";
    },
    [
      canSelectModel,
      canSelectReasoningEffort,
      acceptedCommandId,
      commandMenuIsVisible,
      draft,
      focusComposer,
      matchingCommands,
      menu,
      modelSuggestions,
      onDraftChange,
      onSelectModel,
      onSelectReasoningEffort,
      reasoningSuggestions,
      updateInteraction,
    ],
  );

  const handleCompositionStart = useCallback(() => {
    compositionIsActiveRef.current = true;
  }, []);
  const handleCompositionEnd = useCallback(() => {
    compositionIsActiveRef.current = false;
    lastCompositionEndAtRef.current = Date.now();
  }, []);
  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => setIsFocused(false), []);
  const prepareLiteralSubmit = useCallback(() => {
    updateInteraction({
      dismissedDraft: draft,
      acceptedCommandId: null,
    });
  }, [draft, updateInteraction]);

  return {
    menu,
    activeDescendantId: menu && menu.items.length > 0
      ? composerCommandOptionId(menu.menuId, menu.activeIndex)
      : undefined,
    handleChange,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
    handleFocus,
    handleBlur,
    prepareLiteralSubmit,
  };
}

function commandEmptyMessage(
  commandId: ComposerCommandId | null,
  canSelectModel: boolean,
  canSelectReasoningEffort: boolean,
): string {
  if (commandId === "reasoning") {
    return canSelectReasoningEffort
      ? "No matching efforts. Press Esc to keep this as a prompt."
      : "Reasoning changes are unavailable while rrbox is busy.";
  }
  return canSelectModel
    ? "No matching models. Press Esc to keep this as a prompt."
    : "Model switching is unavailable while rrbox is busy.";
}
