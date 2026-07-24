"use client";

import {
  Folder,
  MessageSquareText,
  Search,
  X,
} from "lucide-react";
import type {
  ProjectSummary,
  SessionSummary,
} from "@researchbox/protocol";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";
import {
  moveChatSearchSelection,
  searchChats,
  type ChatSearchResult,
} from "./chat-search.ts";

const CHAT_SEARCH_RESULT_LIMIT = 100;
const CHAT_SEARCH_LIST_ID = "researchbox-chat-search-results";
const CHAT_SEARCH_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function ChatSearchDialog({
  isOpen,
  isPending,
  projects,
  sessions,
  onClose,
  onSelectSession,
}: {
  isOpen: boolean;
  isPending: boolean;
  projects: readonly ProjectSummary[];
  sessions: readonly SessionSummary[];
  onClose: () => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shouldRestoreFocusRef = useRef(true);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const results = useMemo(
    () => searchChats(projects, sessions, query),
    [projects, query, sessions],
  );
  const visibleResults = results.slice(0, CHAT_SEARCH_RESULT_LIMIT);
  const selectedIndex =
    visibleResults.length === 0
      ? -1
      : Math.min(Math.max(activeIndex, 0), visibleResults.length - 1);
  const activeOptionId =
    selectedIndex >= 0
      ? chatSearchOptionId(selectedIndex)
      : undefined;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        shouldRestoreFocusRef.current = true;
        setQuery("");
        setActiveIndex(0);
        dialog.showModal();
      }
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }

    if (!dialog.open) return;
    dialog.close();
    const returnFocus = returnFocusRef.current;
    const shouldRestoreFocus = shouldRestoreFocusRef.current;
    returnFocusRef.current = null;
    shouldRestoreFocusRef.current = true;
    if (!shouldRestoreFocus) return;
    window.requestAnimationFrame(() => {
      if (
        returnFocus?.isConnected &&
        !returnFocus.closest("[inert]")
      ) {
        returnFocus.focus({ preventScroll: true });
      }
    });
  }, [isOpen]);

  useEffect(() => {
    if (!activeOptionId) return;
    const dialog = dialogRef.current;
    const option = document.getElementById(activeOptionId);
    if (dialog && option && dialog.contains(option)) {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [activeOptionId]);

  function selectResult(result: ChatSearchResult) {
    if (isPending) return;
    shouldRestoreFocusRef.current = false;
    onSelectSession(
      result.project.project_id,
      result.session.session_id,
    );
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        moveChatSearchSelection(
          current,
          visibleResults.length,
          event.key === "ArrowDown" ? "next" : "previous",
        ),
      );
      inputRef.current?.focus();
      return;
    }
    if (
      event.key === "Enter" &&
      event.target === inputRef.current &&
      !event.nativeEvent.isComposing
    ) {
      const result = visibleResults[selectedIndex];
      if (!result) return;
      event.preventDefault();
      selectResult(result);
    }
  }

  const normalizedQuery = query.trim();
  const emptyMessage =
    sessions.length === 0
      ? "No saved chats yet."
      : `No chats found for “${normalizedQuery}”.`;

  return (
    <dialog
      ref={dialogRef}
      className="chat-search-dialog"
      aria-labelledby="chat-search-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <section className="chat-search-panel">
        <header className="chat-search-header">
          <div>
            <h2 id="chat-search-title">Search chats</h2>
            <p>Find a saved chat across every project.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close chat search"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <label className="chat-search-field">
          <Search size={18} aria-hidden={true} />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label="Search saved chats"
            aria-autocomplete="list"
            aria-controls={CHAT_SEARCH_LIST_ID}
            aria-expanded={isOpen}
            aria-activedescendant={activeOptionId}
            autoComplete="off"
            maxLength={160}
            placeholder="Search chats"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
          />
          <kbd aria-hidden={true}>Esc</kbd>
        </label>

        <div className="chat-search-summary" aria-live="polite">
          {visibleResults.length > 0
            ? normalizedQuery
              ? `${results.length} ${results.length === 1 ? "result" : "results"}`
              : "Recent chats"
            : emptyMessage}
        </div>

        <div
          id={CHAT_SEARCH_LIST_ID}
          className="chat-search-results"
          role="listbox"
          aria-label="Saved chats"
        >
          {visibleResults.map((result, index) => {
            const { project, session } = result;
            const isActive = index === selectedIndex;
            const chatTitle = session.title || "Untitled chat";
            return (
              <button
                id={chatSearchOptionId(index)}
                key={`${project.project_id}:${session.session_id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={isActive}
                aria-label={`Open ${chatTitle} in ${project.name}, result ${index + 1} of ${visibleResults.length}`}
                className={`chat-search-result ${isActive ? "active" : ""}`}
                disabled={isPending}
                onFocus={() => setActiveIndex(index)}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectResult(result)}
              >
                <span className="chat-search-result-icon">
                  <MessageSquareText size={17} />
                </span>
                <span className="chat-search-result-copy">
                  <strong>{chatTitle}</strong>
                  <small>
                    <Folder size={12} aria-hidden={true} />
                    {project.name}
                    <span aria-hidden={true}>·</span>
                    <time dateTime={session.updated_at}>
                      {formatChatSearchDate(session.updated_at)}
                    </time>
                    <span aria-hidden={true}>·</span>
                    {session.message_count}{" "}
                    {session.message_count === 1 ? "message" : "messages"}
                  </small>
                </span>
              </button>
            );
          })}
        </div>

        {results.length > CHAT_SEARCH_RESULT_LIMIT && (
          <p className="chat-search-limit">
            Showing the first {CHAT_SEARCH_RESULT_LIMIT} results. Refine your
            search to narrow the list.
          </p>
        )}
      </section>
    </dialog>
  );
}

function chatSearchOptionId(index: number): string {
  return `researchbox-chat-search-option-${index}`;
}

function formatChatSearchDate(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds)
    ? CHAT_SEARCH_DATE_FORMATTER.format(milliseconds)
    : timestamp;
}
