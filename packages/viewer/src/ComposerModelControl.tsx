"use client";

import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import type {
  ModelSelection,
  ProviderSummary,
  ReasoningEffort,
} from "@researchbox/protocol";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  buildComposerModelControlSnapshot,
  formatComposerEffortLabel,
  quickModelsForProvider,
  reasoningSliderIndex,
} from "./composer-model-control.ts";

export type ComposerModelControlProps = {
  providers: readonly ProviderSummary[];
  selection: ModelSelection;
  effort: ReasoningEffort;
  selectionDisabled?: boolean;
  onSelectModel: (providerId: string, modelId: string) => void;
  onSelectEffort: (effort: ReasoningEffort) => void;
  onRefreshProvider: (providerId: string) => void;
  refreshingProviderIds?: ReadonlySet<string>;
};

type MenuView = "quick" | "advanced";
type AdvancedSection = "provider" | "model" | "effort";

const emptyRefreshingProviderIds = new Set<string>();
const arrowKeys = new Set(["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"]);

function providerKindLabel(provider: ProviderSummary): string {
  return provider.kind === "mock" ? "Built in" : "OpenAI compatible";
}

function providerStatusLabel(provider: ProviderSummary): string | null {
  if (provider.status_message) return provider.status_message;
  if (provider.availability === "loading") return "Looking for models…";
  if (provider.availability === "unavailable") {
    return "This provider is not available.";
  }
  return provider.models.length === 0 ? "No models found." : null;
}

function advancedSectionTitle(section: AdvancedSection): string {
  switch (section) {
    case "provider":
      return "Provider";
    case "model":
      return "Model";
    case "effort":
      return "Effort";
  }
}

function previousAdvancedSection(
  section: AdvancedSection,
): AdvancedSection | null {
  if (section === "effort") return "model";
  if (section === "model") return "provider";
  return null;
}

export function ComposerModelControl({
  providers,
  selection,
  effort,
  selectionDisabled = false,
  onSelectModel,
  onSelectEffort,
  onRefreshProvider,
  refreshingProviderIds = emptyRefreshingProviderIds,
}: ComposerModelControlProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<MenuView>("quick");
  const [advancedSection, setAdvancedSection] =
    useState<AdvancedSection>("provider");
  const [browsedProviderId, setBrowsedProviderId] = useState(
    selection.provider_id,
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();
  const headingId = useId();
  const effortScaleId = useId();

  const snapshot = useMemo(
    () => buildComposerModelControlSnapshot(providers, selection, effort),
    [effort, providers, selection],
  );
  const quickModels = useMemo(
    () => quickModelsForProvider(snapshot.selected_provider),
    [snapshot.selected_provider],
  );
  const browsedProvider = providers.find(
    (provider) => provider.provider_id === browsedProviderId,
  ) ?? snapshot.selected_provider ?? providers[0];
  const browsedProviderHasSelection =
    browsedProvider?.provider_id === selection.provider_id &&
    browsedProvider.models.some(
      (model) => model.model_id === selection.model_id,
    );
  const activeEffortIndex = reasoningSliderIndex(
    snapshot.effort_options,
    effort,
  );
  const activeEffortOption = snapshot.effort_options[activeEffortIndex];
  const effortProgress = snapshot.effort_options.length <= 1
    ? 0
    : (activeEffortIndex / (snapshot.effort_options.length - 1)) * 100;
  const triggerEffortLabel = formatComposerEffortLabel(effort);

  const closeAndRestoreFocus = useCallback(() => {
    setIsOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("focusin", closeOnOutsideFocus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("focusin", closeOnOutsideFocus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeAndRestoreFocus, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      const focusScope = view === "advanced"
        ? rootRef.current?.querySelector<HTMLElement>(
          `[data-section="${advancedSection}"]`,
        )
        : rootRef.current;
      const target = focusScope?.querySelector<HTMLElement>(
        '[data-model-control-autofocus="true"]',
      );
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [advancedSection, isOpen, view]);

  function toggleMenu() {
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    setView("quick");
    setAdvancedSection("provider");
    setBrowsedProviderId(selection.provider_id);
    setIsOpen(true);
  }

  function selectModel(providerId: string, modelId: string) {
    if (selectionDisabled) return;
    if (
      providerId !== selection.provider_id ||
      modelId !== selection.model_id
    ) {
      onSelectModel(providerId, modelId);
    }
  }

  function selectEffort(nextEffort: ReasoningEffort) {
    if (selectionDisabled || nextEffort === effort) return;
    onSelectEffort(nextEffort);
  }

  function moveRadioFocus(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    group: string,
  ) {
    if (
      !arrowKeys.has(event.key) &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const options = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(
        `[data-model-control-radio="${group}"][aria-disabled="false"]`,
      ) ?? [],
    );
    if (options.length === 0) return;
    event.preventDefault();
    const currentIndex = options.indexOf(event.currentTarget);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (
          currentIndex +
          (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) +
          options.length
        ) % options.length;
    options[nextIndex]?.focus();
  }

  return (
    <div className="composer-model-control-root" ref={rootRef}>
      <button
        className={`composer-model-control-trigger ${
          snapshot.model_availability
        }`}
        type="button"
        ref={triggerRef}
        aria-label={`Model and reasoning settings: ${snapshot.model_path}, ${
          triggerEffortLabel
        }. ${snapshot.model_status}.`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        onClick={toggleMenu}
      >
        <span
          className={`composer-model-status ${snapshot.model_availability}`}
          title={snapshot.model_status}
          aria-hidden="true"
        />
        <strong>{snapshot.model_path}</strong>
        <span className="composer-model-control-separator" aria-hidden="true">
          ·
        </span>
        <span className="composer-model-control-effort">
          {triggerEffortLabel}
        </span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          className={`composer-model-popover ${
            view === "advanced" ? "advanced" : "quick"
          }`}
          id={popoverId}
          role="dialog"
          aria-labelledby={headingId}
        >
          <div className="composer-model-popover-header">
            {view === "advanced" ? (
              <button
                className="composer-model-header-action back"
                type="button"
                onClick={() => {
                  setView("quick");
                  setAdvancedSection("provider");
                }}
              >
                <ChevronLeft size={14} aria-hidden="true" />
                Quick settings
              </button>
            ) : (
              <span className="composer-model-popover-kicker">
                This chat
              </span>
            )}
            <strong id={headingId}>
              {view === "advanced" ? "Advanced model settings" : "Model & reasoning"}
            </strong>
            {view === "quick" ? (
              <button
                className="composer-model-header-action"
                type="button"
                onClick={() => {
                  setView("advanced");
                  setAdvancedSection("provider");
                  setBrowsedProviderId(selection.provider_id);
                }}
              >
                Advanced
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            ) : (
              <span className="composer-model-popover-kicker end">
                Provider · Model · Effort
              </span>
            )}
          </div>

          {view === "quick" ? (
            <div className="composer-model-quick-view">
              <section className="composer-model-quick-section">
                <div className="composer-model-section-heading">
                  <strong>Models</strong>
                  <span>
                    {snapshot.selected_provider?.display_name ?? "Choose a provider"}
                  </span>
                </div>
                <div
                  className="composer-model-quick-list"
                  role="radiogroup"
                  aria-label="Models from the current provider"
                >
                  {quickModels.map((model, index) => {
                    const isSelected =
                      model.provider_id === selection.provider_id &&
                      model.model_id === selection.model_id;
                    const canSelect = !selectionDisabled;
                    return (
                      <button
                        className={`composer-model-option ${
                          isSelected ? "selected" : ""
                        }`}
                        type="button"
                        role="radio"
                        key={`${model.provider_id}:${model.model_id}`}
                        aria-checked={isSelected}
                        aria-disabled={!canSelect}
                        data-model-control-radio="quick-model"
                        data-model-control-autofocus={
                          isSelected || (index === 0 && !snapshot.selected_model)
                        }
                        onClick={() => {
                          if (canSelect) {
                            selectModel(model.provider_id, model.model_id);
                          }
                        }}
                        onKeyDown={(event) =>
                          moveRadioFocus(event, "quick-model")}
                      >
                        <span>
                          <strong>{model.display_name}</strong>
                          {model.display_name !== model.model_id && (
                            <small>{model.model_id}</small>
                          )}
                        </span>
                        <Check size={15} aria-hidden="true" />
                      </button>
                    );
                  })}
                  {quickModels.length === 0 && (
                    <p className="composer-model-empty" role="status">
                      No ready models are available from this provider. Open
                      Advanced to choose another provider.
                    </p>
                  )}
                </div>
              </section>

              <section className="composer-model-quick-section effort">
                <div className="composer-model-section-heading">
                  <strong>Reasoning effort</strong>
                  <span>{activeEffortOption?.title ?? triggerEffortLabel}</span>
                </div>
                {snapshot.effort_options.length > 1 ? (
                  <div className="composer-effort-slider">
                    <input
                      type="range"
                      min={0}
                      max={snapshot.effort_options.length - 1}
                      step={1}
                      value={activeEffortIndex}
                      list={effortScaleId}
                      aria-label="Reasoning effort"
                      aria-valuetext={
                        activeEffortOption?.title ?? triggerEffortLabel
                      }
                      aria-disabled={selectionDisabled}
                      style={{
                        "--composer-effort-progress": `${effortProgress}%`,
                      } as CSSProperties}
                      onChange={(event) => {
                        const option = snapshot.effort_options[
                          Number(event.currentTarget.value)
                        ];
                        if (option) selectEffort(option.suggestionId);
                      }}
                    />
                    <datalist id={effortScaleId}>
                      {snapshot.effort_options.map((option, index) => (
                        <option
                          key={option.suggestionId}
                          value={index}
                          label={formatComposerEffortLabel(option.suggestionId)}
                        />
                      ))}
                    </datalist>
                    <div
                      className="composer-effort-labels"
                      aria-hidden="true"
                      style={{
                        gridTemplateColumns: `repeat(${
                          snapshot.effort_options.length
                        }, minmax(0, 1fr))`,
                      }}
                    >
                      {snapshot.effort_options.map((option) => (
                        <span
                          className={
                            option.suggestionId === effort ? "selected" : ""
                          }
                          key={option.suggestionId}
                        >
                          {formatComposerEffortLabel(option.suggestionId)}
                        </span>
                      ))}
                    </div>
                    <p>{activeEffortOption?.description}</p>
                  </div>
                ) : (
                  <div className="composer-effort-fixed">
                    <span>{triggerEffortLabel}</span>
                    <p>
                      {activeEffortOption?.description ??
                        "This model does not advertise reasoning controls."}
                    </p>
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div
              className="composer-model-advanced-view"
              data-active-section={advancedSection}
            >
              <div className="composer-model-mobile-step">
                <button
                  type="button"
                  aria-label="Go to the previous advanced setting"
                  onClick={() => {
                    const previous = previousAdvancedSection(advancedSection);
                    if (previous) {
                      setAdvancedSection(previous);
                    } else {
                      setView("quick");
                    }
                  }}
                >
                  <ChevronLeft size={15} aria-hidden="true" />
                </button>
                <strong>{advancedSectionTitle(advancedSection)}</strong>
                <span>
                  {advancedSection === "provider"
                    ? "1 of 3"
                    : advancedSection === "model"
                      ? "2 of 3"
                      : "3 of 3"}
                </span>
              </div>

              <section
                className="composer-model-advanced-pane provider"
                data-section="provider"
                aria-label="Providers"
              >
                <div className="composer-model-advanced-heading">
                  <strong>Provider</strong>
                  <span>{providers.length}</span>
                </div>
                <div className="composer-model-advanced-list">
                  {providers.map((provider) => {
                    const isBrowsed =
                      provider.provider_id === browsedProvider?.provider_id;
                    const isRefreshing = refreshingProviderIds.has(
                      provider.provider_id,
                    );
                    return (
                      <div
                        className={`composer-provider-row ${
                          isBrowsed ? "selected" : ""
                        }`}
                        key={provider.provider_id}
                      >
                        <button
                          className="composer-provider-option"
                          type="button"
                          aria-pressed={isBrowsed}
                          data-model-control-autofocus={isBrowsed}
                          onClick={() => {
                            setBrowsedProviderId(provider.provider_id);
                            setAdvancedSection("model");
                          }}
                        >
                          <span
                            className={`composer-model-status ${provider.availability}`}
                            aria-hidden="true"
                          />
                          <span>
                            <strong>{provider.display_name}</strong>
                            <small>
                              {providerKindLabel(provider)} · {provider.models.length}
                            </small>
                          </span>
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                        {provider.kind === "openai_compatible" && (
                          <button
                            className="composer-provider-refresh"
                            type="button"
                            disabled={
                              provider.availability === "loading" || isRefreshing
                            }
                            aria-label={`Refresh models from ${provider.display_name}`}
                            onClick={() => onRefreshProvider(provider.provider_id)}
                          >
                            {provider.availability === "loading" || isRefreshing ? (
                              <LoaderCircle
                                className="model-selector-spinner"
                                size={14}
                                aria-hidden="true"
                              />
                            ) : (
                              <RefreshCw size={14} aria-hidden="true" />
                            )}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {providers.length === 0 && (
                    <p className="composer-model-empty" role="status">
                      No model providers are configured.
                    </p>
                  )}
                </div>
              </section>

              <section
                className="composer-model-advanced-pane model"
                data-section="model"
                aria-label="Models"
              >
                <div className="composer-model-advanced-heading">
                  <strong>Model</strong>
                  <span>{browsedProvider?.display_name ?? "No provider"}</span>
                </div>
                <div
                  className="composer-model-advanced-list"
                  role="radiogroup"
                  aria-label="Models"
                >
                  {browsedProvider?.models.map((model, index) => {
                    const isSelected =
                      model.provider_id === selection.provider_id &&
                      model.model_id === selection.model_id;
                    const canSelect =
                      !selectionDisabled &&
                      browsedProvider.availability === "ready" &&
                      model.availability === "ready";
                    return (
                      <button
                        className={`composer-model-option advanced ${
                          isSelected ? "selected" : ""
                        }`}
                        type="button"
                        role="radio"
                        key={`${model.provider_id}:${model.model_id}`}
                        aria-checked={isSelected}
                        aria-disabled={!canSelect}
                        data-model-control-radio="advanced-model"
                        data-model-control-autofocus={
                          isSelected ||
                          (index === 0 && !browsedProviderHasSelection)
                        }
                        onClick={() => {
                          if (!canSelect) return;
                          selectModel(model.provider_id, model.model_id);
                          setAdvancedSection("effort");
                        }}
                        onKeyDown={(event) =>
                          moveRadioFocus(event, "advanced-model")}
                      >
                        <span>
                          <strong>{model.display_name}</strong>
                          <small>{model.model_id}</small>
                          {model.status_message && (
                            <small className="status">{model.status_message}</small>
                          )}
                        </span>
                        {isSelected ? (
                          <Check size={15} aria-hidden="true" />
                        ) : (
                          <ChevronRight
                            className="composer-model-mobile-arrow"
                            size={14}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    );
                  })}
                  {browsedProvider && providerStatusLabel(browsedProvider) && (
                    <p
                      className={`composer-model-empty ${
                        browsedProvider.availability
                      }`}
                      role="status"
                    >
                      {providerStatusLabel(browsedProvider)}
                    </p>
                  )}
                  {!browsedProvider && (
                    <p className="composer-model-empty" role="status">
                      Choose a provider first.
                    </p>
                  )}
                </div>
              </section>

              <section
                className="composer-model-advanced-pane effort"
                data-section="effort"
                aria-label="Reasoning effort"
              >
                <div className="composer-model-advanced-heading">
                  <strong>Effort</strong>
                  <span>{snapshot.selected_model?.display_name ?? "No model"}</span>
                </div>
                <div
                  className="composer-model-advanced-list"
                  role="radiogroup"
                  aria-label="Reasoning effort"
                >
                  {snapshot.effort_options.map((option, index) => {
                    const canSelect = !selectionDisabled;
                    return (
                      <button
                        className={`composer-effort-option ${
                          option.isSelected ? "selected" : ""
                        }`}
                        type="button"
                        role="radio"
                        key={option.suggestionId}
                        aria-checked={option.isSelected}
                        aria-disabled={!canSelect}
                        data-model-control-radio="advanced-effort"
                        data-model-control-autofocus={
                          option.isSelected ||
                          (index === 0 &&
                            !snapshot.effort_options.some(
                              (candidate) => candidate.isSelected,
                            ))
                        }
                        onClick={() => {
                          if (canSelect) selectEffort(option.suggestionId);
                        }}
                        onKeyDown={(event) =>
                          moveRadioFocus(event, "advanced-effort")}
                      >
                        <span>
                          <strong>
                            {formatComposerEffortLabel(option.suggestionId)}
                          </strong>
                          <small>{option.description}</small>
                        </span>
                        <Check size={15} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                {selectionDisabled && (
                  <p className="composer-model-notice" role="status">
                    You can change these settings after the current operation
                    finishes.
                  </p>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
