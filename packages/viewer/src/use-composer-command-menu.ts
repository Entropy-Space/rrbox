import type {
  ModelSelection,
  ProviderSummary,
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
  isImeCommitKey,
  matchComposerCommands,
  modelCommandQuery,
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
  canSelectModel: boolean;
  onDraftChange: (draft: string) => void;
  onSelectModel: (providerId: string, modelId: string) => void;
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
  canSelectModel,
  onDraftChange,
  onSelectModel,
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

  const acceptedModelQuery = acceptedCommandId === "model"
    ? modelCommandQuery(draft)
    : null;
  const isModelCommandAccepted = acceptedModelQuery !== null;
  const matchingCommands = useMemo(
    () => matchComposerCommands(draft),
    [draft],
  );
  const modelSuggestions = useMemo(
    () => isModelCommandAccepted && canSelectModel
      ? buildComposerModelSuggestions(
          providers,
          selection,
          acceptedModelQuery,
        )
      : [],
    [
      acceptedModelQuery,
      canSelectModel,
      isModelCommandAccepted,
      providers,
      selection,
    ],
  );
  const menuIsDismissed = dismissedDraft === draft;
  const commandMenuIsVisible =
    isFocused &&
    !menuIsDismissed &&
    !isModelCommandAccepted &&
    matchingCommands.length > 0;
  const modelMenuIsVisible =
    isFocused &&
    !menuIsDismissed &&
    isModelCommandAccepted;

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
  const visibleItems = modelMenuIsVisible ? modelItems : commandItems;
  const fallbackIndex = modelMenuIsVisible
    ? Math.max(0, modelSuggestions.findIndex((model) => model.isSelected))
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
      : modelMenuIsVisible
        ? {
            menuId,
            label: "Choose a model",
            items: modelItems,
            activeIndex: visibleActiveIndex,
            emptyMessage: canSelectModel
              ? "No matching models. Press Esc to keep this as a prompt."
              : "Model switching is unavailable while rrbox is busy.",
          }
        : null,
    [
      canSelectModel,
      commandItems,
      commandMenuIsVisible,
      menuId,
      modelItems,
      modelMenuIsVisible,
      visibleActiveIndex,
    ],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const nextDraft = event.target.value;
      updateInteraction((current) => ({
        dismissedDraft: null,
        activeIndex: 0,
        acceptedCommandId: modelCommandQuery(nextDraft) === null
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

      const model = modelSuggestions[selectedIndex];
      if (!model || !canSelectModel) return "handled";
      if (!model.isSelected) {
        onSelectModel(model.providerId, model.modelId);
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
      commandMenuIsVisible,
      draft,
      focusComposer,
      matchingCommands,
      menu,
      modelSuggestions,
      onDraftChange,
      onSelectModel,
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
