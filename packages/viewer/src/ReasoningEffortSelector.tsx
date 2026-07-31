"use client";

import { BrainCircuit, Check, ChevronDown } from "lucide-react";
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
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  buildComposerReasoningSuggestions,
  formatReasoningEffort,
} from "./composer-commands.ts";

export type ReasoningEffortSelectorProps = {
  providers: readonly ProviderSummary[];
  selection: ModelSelection;
  effort: ReasoningEffort;
  selectionDisabled?: boolean;
  onSelect: (effort: ReasoningEffort) => void;
};

export function ReasoningEffortSelector({
  providers,
  selection,
  effort,
  selectionDisabled = false,
  onSelect,
}: ReasoningEffortSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverId = useId();
  const headingId = useId();
  const options = useMemo(
    () => buildComposerReasoningSuggestions(
      providers,
      selection,
      effort,
      "",
    ),
    [effort, providers, selection],
  );
  const activeOption = options.find((option) => option.isSelected);
  const fallbackTabStop = activeOption?.suggestionId ??
    options[0]?.suggestionId;
  const activeLabel = formatReasoningEffort(effort);
  const activeDescription = activeOption?.description ??
    "The selected model no longer advertises this reasoning effort.";

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
      rootRef.current
        ?.querySelector<HTMLElement>(
          '[role="radio"][aria-checked="true"], [role="radio"]',
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  function chooseEffort(nextEffort: ReasoningEffort) {
    if (selectionDisabled) return;
    if (nextEffort !== effort) onSelect(nextEffort);
    closeAndRestoreFocus();
  }

  function handleOptionKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    optionIndex: number,
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
    if (options.length === 0) return;

    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (
          optionIndex +
          (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) +
          options.length
        ) % options.length;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-reasoning-index="${nextIndex}"]`)
      ?.focus();
  }

  return (
    <div
      className="reasoning-effort-root"
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
        className="reasoning-effort-trigger"
        type="button"
        ref={triggerRef}
        title={`Reasoning effort: ${activeLabel}`}
        aria-label={`Reasoning effort: ${activeLabel}. ${activeDescription}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        onClick={() => setIsOpen((open) => !open)}
      >
        <BrainCircuit size={15} aria-hidden="true" />
        <span>{activeLabel}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          className="reasoning-effort-popover"
          id={popoverId}
          role="dialog"
          aria-labelledby={headingId}
        >
          <div className="reasoning-effort-header">
            <strong id={headingId}>Reasoning effort</strong>
            <span>For this chat</span>
          </div>
          <div
            className="reasoning-effort-options"
            role="radiogroup"
            aria-label="Reasoning effort"
          >
            {options.map((option, index) => (
              <button
                className={`reasoning-effort-option ${
                  option.isSelected ? "selected" : ""
                }`}
                type="button"
                role="radio"
                key={option.suggestionId}
                aria-checked={option.isSelected}
                aria-disabled={selectionDisabled}
                tabIndex={option.suggestionId === fallbackTabStop ? 0 : -1}
                data-reasoning-index={index}
                onClick={() => chooseEffort(option.suggestionId)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
              >
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
                <Check size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
          {selectionDisabled && (
            <p className="reasoning-effort-notice" role="status">
              You can change this after the current operation finishes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
