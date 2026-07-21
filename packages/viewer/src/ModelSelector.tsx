"use client";

import {
  Check,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import type {
  ModelSelection,
  ProviderSummary,
} from "@researchbox/protocol";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type ModelSelectorProps = {
  providers: ProviderSummary[];
  selection: ModelSelection;
  disabled?: boolean;
  onSelect: (providerId: string, modelId: string) => void;
  onRefresh: (providerId: string) => void;
  refreshingProviderIds?: ReadonlySet<string>;
};

const emptyRefreshingProviderIds = new Set<string>();

function providerKindLabel(provider: ProviderSummary) {
  return provider.kind === "mock" ? "Built in" : "OpenAI compatible";
}

function providerStatusLabel(provider: ProviderSummary) {
  if (provider.status_message) return provider.status_message;
  if (provider.availability === "loading") return "Looking for models…";
  if (provider.availability === "unavailable") {
    return "This provider is not available.";
  }
  return provider.models.length === 0 ? "No models found." : null;
}

export function ModelSelector({
  providers,
  selection,
  disabled = false,
  onSelect,
  onRefresh,
  refreshingProviderIds = emptyRefreshingProviderIds,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();
  const headingId = useId();

  const selectedProvider = providers.find(
    (provider) => provider.provider_id === selection.provider_id,
  );
  const selectedModel = selectedProvider?.models.find(
    (model) => model.model_id === selection.model_id,
  );
  const selectedAvailability = !selectedProvider
    ? "loading"
    : selectedProvider.availability === "loading"
      ? "loading"
      : selectedProvider.availability === "unavailable" ||
          selectedModel?.availability === "unavailable"
        ? "unavailable"
        : selectedModel
          ? "ready"
          : "unavailable";
  const selectedStatus =
    selectedAvailability === "loading"
      ? "Loading model"
      : selectedAvailability === "unavailable"
        ? "Model unavailable"
        : "Model ready";

  const availableModelKeys = useMemo(
    () =>
      providers.flatMap((provider) =>
        provider.availability === "ready"
          ? provider.models.flatMap((model) =>
              model.availability === "ready"
                ? [`${provider.provider_id}\u0000${model.model_id}`]
                : [],
            )
          : [],
      ),
    [providers],
  );
  const selectedModelKey = `${selection.provider_id}\u0000${selection.model_id}`;
  const fallbackTabStopKey = availableModelKeys.includes(selectedModelKey)
    ? null
    : availableModelKeys[0];

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
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeAndRestoreFocus, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const frame = requestAnimationFrame(() => {
      const selectedOption = rootRef.current?.querySelector<HTMLElement>(
        '[role="radio"][aria-checked="true"][aria-disabled="false"]',
      );
      const firstOption = rootRef.current?.querySelector<HTMLElement>(
        '[role="radio"][aria-disabled="false"]',
      );
      const firstAction = rootRef.current?.querySelector<HTMLElement>(
        "[data-model-selector-action]",
      );
      (selectedOption ?? firstOption ?? firstAction)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!disabled) return;
    const frame = requestAnimationFrame(() => setIsOpen(false));
    return () => cancelAnimationFrame(frame);
  }, [disabled]);

  function selectModel(providerId: string, modelId: string) {
    if (disabled) return;
    if (
      providerId !== selection.provider_id ||
      modelId !== selection.model_id
    ) {
      onSelect(providerId, modelId);
    }
    closeAndRestoreFocus();
  }

  function handleOptionKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    providerId: string,
    modelId: string,
  ) {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowRight" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowLeft" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    event.preventDefault();
    const currentKey = `${providerId}\u0000${modelId}`;
    const currentIndex = availableModelKeys.indexOf(currentKey);
    if (currentIndex < 0 || availableModelKeys.length === 0) return;

    let nextIndex: number;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = availableModelKeys.length - 1;
    } else {
      const offset =
        event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
      nextIndex =
        (currentIndex + offset + availableModelKeys.length) %
        availableModelKeys.length;
    }

    const [nextProviderId, nextModelId] = availableModelKeys[nextIndex].split(
      "\u0000",
      2,
    );
    rootRef.current
      ?.querySelector<HTMLElement>(
        `[data-provider-id="${CSS.escape(nextProviderId)}"][data-model-id="${CSS.escape(nextModelId)}"]`,
      )
      ?.focus();
  }

  return (
    <div
      className="model-selector-root"
      ref={rootRef}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (
          isOpen &&
          (!(nextTarget instanceof Node) ||
            !event.currentTarget.contains(nextTarget))
        ) {
          setIsOpen(false);
        }
      }}
    >
      <button
        className={`model-selector ${selectedAvailability}`}
        type="button"
        ref={triggerRef}
        aria-label={`${selectedModel?.display_name || selection.model_id || "Loading model"}. ${selectedStatus}.`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) setIsOpen((open) => !open);
        }}
      >
        <span className="model-selector-copy">
          <strong className="model-selector-title">
            {selectedModel?.display_name || selection.model_id || "Loading model…"}
          </strong>
          <small className="model-selector-provider">
            {selectedProvider?.display_name ?? "Starting browser core"}
          </small>
        </span>
        <span
          className={`model-selector-active-status ${selectedAvailability}`}
          title={selectedStatus}
          aria-hidden="true"
        />
        <ChevronDown
          className="model-selector-chevron"
          size={15}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          className="model-selector-popover"
          id={popoverId}
          role="dialog"
          aria-labelledby={headingId}
        >
          <div className="model-selector-popover-header">
            <strong id={headingId}>Choose a model</strong>
            <span>Provider and model</span>
          </div>

          <div className="model-selector-provider-list">
            {providers.map((provider) => {
              const isRefreshPending = refreshingProviderIds.has(
                provider.provider_id,
              );
              const statusLabel = isRefreshPending
                ? "Looking for models…"
                : providerStatusLabel(provider);
              const canSelectProvider =
                provider.availability === "ready" && !isRefreshPending;

              return (
                <section
                  className="model-selector-provider-section"
                  key={provider.provider_id}
                  aria-label={provider.display_name}
                >
                  <div className="model-selector-provider-heading">
                    <span className="model-selector-provider-identity">
                      <span
                        className={`model-selector-provider-status ${provider.availability}`}
                        aria-hidden="true"
                      />
                      <strong>{provider.display_name}</strong>
                      <small>{providerKindLabel(provider)}</small>
                    </span>
                    {provider.kind === "openai_compatible" && (
                      <button
                        className="model-selector-refresh"
                        type="button"
                        data-model-selector-action
                        disabled={
                          disabled ||
                          provider.availability === "loading" ||
                          isRefreshPending
                        }
                        aria-label={`Refresh models from ${provider.display_name}`}
                        onClick={() => {
                          onRefresh(provider.provider_id);
                        }}
                      >
                        {provider.availability === "loading" ||
                        isRefreshPending ? (
                          <LoaderCircle
                            className="model-selector-spinner"
                            size={14}
                            aria-hidden="true"
                          />
                        ) : (
                          <RefreshCw size={14} aria-hidden="true" />
                        )}
                        <span>
                          {provider.availability === "unavailable"
                            ? "Retry"
                            : "Refresh"}
                        </span>
                      </button>
                    )}
                  </div>

                  {statusLabel && (
                    <p
                      className={`model-selector-provider-message ${provider.availability}`}
                      role={
                        provider.availability === "unavailable"
                          ? "alert"
                          : "status"
                      }
                    >
                      {statusLabel}
                    </p>
                  )}

                  {provider.models.length > 0 && (
                    <div
                      className="model-selector-options"
                      role="radiogroup"
                      aria-label={`${provider.display_name} models`}
                    >
                      {provider.models.map((model) => {
                        const modelKey = `${provider.provider_id}\u0000${model.model_id}`;
                        const isSelected =
                          provider.provider_id === selection.provider_id &&
                          model.model_id === selection.model_id;
                        const canSelect =
                          canSelectProvider &&
                          model.availability === "ready" &&
                          !disabled;

                        return (
                          <button
                            className={`model-selector-option ${isSelected ? "selected" : ""}`}
                            type="button"
                            role="radio"
                            key={`${provider.provider_id}:${model.model_id}`}
                            aria-checked={isSelected}
                            aria-disabled={!canSelect}
                            tabIndex={
                              canSelect &&
                              (isSelected || modelKey === fallbackTabStopKey)
                                ? 0
                                : -1
                            }
                            data-provider-id={provider.provider_id}
                            data-model-id={model.model_id}
                            onClick={() => {
                              if (canSelect) {
                                selectModel(
                                  provider.provider_id,
                                  model.model_id,
                                );
                              }
                            }}
                            onKeyDown={(event) =>
                              handleOptionKeyDown(
                                event,
                                provider.provider_id,
                                model.model_id,
                              )
                            }
                          >
                            <span>
                              <strong>{model.display_name}</strong>
                              {model.display_name !== model.model_id && (
                                <small>{model.model_id}</small>
                              )}
                              {model.availability === "unavailable" && (
                                <small className="model-selector-option-status">
                                  {model.status_message ?? "Unavailable"}
                                </small>
                              )}
                            </span>
                            <Check size={16} aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}

            {providers.length === 0 && (
              <p className="model-selector-empty" role="status">
                No model providers are configured.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
