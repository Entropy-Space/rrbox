"use client";

import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  Menu,
  MessageSquareText,
  Mic,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import {
  type AssistantBlock,
  type AssistantMessageEntry,
  type FileEntry,
  type ToolCallBlock,
  type ToolResultEntry,
} from "@researchbox/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  isModalNavigationOpen,
  MOBILE_NAVIGATION_QUERY,
} from "./navigation-state.ts";
import { ModelSelector } from "./ModelSelector.tsx";
import {
  buildAssistantRunPresentation,
  buildTimelineRows,
  getToolResultCopy,
  type AssistantTurnPresentation,
} from "./timeline-rendering.ts";
import { useAgentSession } from "./use-agent-session.ts";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";

export type ResearchBoxViewerProps = {
  createWorker: () => Worker;
};

const suggestions = [
  {
    icon: FileText,
    label: "Create a workspace note",
    prompt: "Create a workspace note that summarizes this prototype.",
  },
  {
    icon: FolderOpen,
    label: "Inspect the workspace",
    prompt: "Inspect the workspace and tell me what is already implemented.",
  },
  {
    icon: Code2,
    label: "Read the project README",
    prompt: "Read the README and suggest the next implementation step.",
  },
  {
    icon: Sparkles,
    label: "Explain the architecture",
    prompt: "Explain how the core and viewer communicate in this prototype.",
  },
];

export function ResearchBoxViewer({ createWorker }: ResearchBoxViewerProps) {
  const {
    coreState,
    transportError,
    isManagementPending,
    isInputDraftPending,
    isActiveModelReady,
    refreshingProviderIds,
    submitPrompt,
    updateInputDraft,
    createProject,
    renameProject,
    deleteProject,
    selectProject,
    selectNewChat,
    selectModel,
    refreshProvider,
    renameSession,
    deleteSession,
    selectSession,
    abortRun,
    openFile,
    navigateToParent,
  } = useAgentSession(createWorker);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobileViewport, setMobileViewport] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineRows = useMemo(
    () => buildTimelineRows(coreState.timeline),
    [coreState.timeline],
  );
  const activeRunId = coreState.is_running
    ? coreState.timeline.at(-1)?.run_id ?? null
    : null;

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({
      behavior: coreState.is_running ? "smooth" : "auto",
      block: "end",
    });
  }, [coreState.timeline, coreState.is_running]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_NAVIGATION_QUERY);
    const syncViewport = () => {
      setMobileViewport(mediaQuery.matches);
      if (!mediaQuery.matches) setSidebarOpen(false);
    };
    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);
    return () => mediaQuery.removeEventListener("change", syncViewport);
  }, []);

  const submitDraft = useCallback(
    (prompt: string) => {
      submitPrompt(prompt);
    },
    [submitPrompt],
  );
  const selectNewChatAndFocus = useCallback(
    (projectId?: string) => {
      selectNewChat(projectId);
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    [selectNewChat],
  );
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!coreState.is_ready) return;
    composerRef.current?.focus();
  }, [
    coreState.active_project_id,
    coreState.active_session_id,
    coreState.is_ready,
  ]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitDraft(coreState.input_draft);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submitDraft(coreState.input_draft);
    }
  }

  const hasConversation = coreState.timeline.length > 0;
  const visibleError = transportError ?? coreState.error_message;
  const visibleCoreStatus =
    !coreState.is_ready &&
    (coreState.core_lifecycle === "waiting_for_writer" ||
      coreState.core_lifecycle === "failed")
      ? coreState.core_status_message
      : null;
  const coreStatusLabel = coreState.is_ready
    ? "Local core"
    : coreState.core_lifecycle === "waiting_for_writer"
      ? "Waiting"
      : coreState.core_lifecycle === "failed"
        ? "Unavailable"
        : "Starting";
  const modalNavigationOpen = isModalNavigationOpen(
    sidebarOpen,
    isMobileViewport,
  );

  return (
    <main className="app-shell">
      {modalNavigationOpen && (
        <button
          className="mobile-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={closeSidebar}
        />
      )}

      <WorkspaceSidebar
        isOpen={modalNavigationOpen}
        projects={coreState.projects}
        sessions={coreState.sessions}
        activeProjectId={coreState.active_project_id}
        activeSessionId={coreState.active_session_id}
        isPending={
          isManagementPending ||
          isInputDraftPending ||
          coreState.is_running ||
          coreState.pending_prompt !== null
        }
        onClose={closeSidebar}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onSelectProject={selectProject}
        onSelectNewChat={selectNewChatAndFocus}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onSelectSession={selectSession}
      />

      <section
        className="chat-surface"
        inert={modalNavigationOpen ? true : undefined}
      >
        <header className="topbar">
          <div className="topbar-leading">
            <button
              className="icon-button mobile-menu-button"
              type="button"
              aria-label="Open navigation"
              aria-controls="researchbox-navigation"
              aria-expanded={modalNavigationOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <ModelSelector
              providers={coreState.providers}
              selection={coreState.active_model}
              selectionDisabled={
                !coreState.is_ready ||
                coreState.is_running ||
                isManagementPending ||
                coreState.pending_prompt !== null
              }
              onSelect={selectModel}
              onRefresh={refreshProvider}
              refreshingProviderIds={refreshingProviderIds}
            />
          </div>
          <div className="topbar-actions">
            <span
              className={`core-status ${coreState.is_ready ? "online" : coreState.core_lifecycle}`}
              title={
                coreState.is_ready
                  ? "Browser core ready"
                  : (coreState.core_status_message ?? "Starting browser core")
              }
            >
              <span />
              {coreStatusLabel}
            </span>
            <button
              className={`workspace-toggle ${workspaceOpen ? "active" : ""}`}
              type="button"
              aria-label={workspaceOpen ? "Close workspace" : "Open workspace"}
              aria-expanded={workspaceOpen}
              onClick={() => setWorkspaceOpen((open) => !open)}
            >
              <PanelRight size={17} />
              <span>Workspace</span>
            </button>
          </div>
        </header>

        <div className="chat-layout">
          <div className="conversation-column">
            {!hasConversation ? (
              <EmptyConversation
                isReady={coreState.is_ready && isActiveModelReady}
                onSelectPrompt={submitDraft}
              />
            ) : (
              <div className="message-list" aria-live="polite">
                {timelineRows.map((row) =>
                  row.type === "user" ? (
                    <UserMessageRow
                      key={row.entry.entry_id}
                      content={row.entry.content}
                    />
                  ) : (
                    <AssistantRunRow
                      key={`${row.run_id}:${row.entries[0]?.entry_id ?? "empty"}`}
                      entries={row.entries}
                      isRunActive={row.run_id === activeRunId}
                    />
                  ),
                )}
                <div ref={conversationEndRef} />
              </div>
            )}

            <div className="composer-region">
              {visibleCoreStatus && (
                <div
                  className={`status-banner ${coreState.core_lifecycle}`}
                  role={
                    coreState.core_lifecycle === "failed" ? "alert" : "status"
                  }
                >
                  {visibleCoreStatus}
                </div>
              )}
              {visibleError && <div className="error-banner">{visibleError}</div>}
              <form className="composer" onSubmit={handleSubmit}>
                <textarea
                  ref={composerRef}
                  value={coreState.input_draft}
                  rows={1}
                  aria-label="Message ResearchBox"
                  placeholder="Message ResearchBox"
                  disabled={!coreState.is_ready || isManagementPending}
                  onChange={(event) => updateInputDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                />
                <div className="composer-controls">
                  <div className="composer-tools">
                    <button type="button" aria-label="Add attachment">
                      <Plus size={19} />
                    </button>
                    <button type="button" className="tools-pill">
                      <SlidersHorizontal size={16} />
                      <span>Tools</span>
                    </button>
                  </div>
                  <div className="composer-actions">
                    <button type="button" aria-label="Attach a file">
                      <Paperclip size={18} />
                    </button>
                    <button type="button" aria-label="Voice input">
                      <Mic size={19} />
                    </button>
                    {coreState.is_running ? (
                      <button
                        className="send-button stop-button"
                        type="button"
                        aria-label="Stop response"
                        onClick={abortRun}
                      >
                        <span />
                      </button>
                    ) : (
                      <button
                        className="send-button"
                        type="submit"
                        aria-label="Send message"
                        disabled={
                          !coreState.input_draft.trim() ||
                          !coreState.is_ready ||
                          !isActiveModelReady ||
                          isManagementPending ||
                          coreState.pending_prompt !== null
                        }
                      >
                        <ArrowUp size={18} strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <p className="composer-note">
                ResearchBox can make mistakes. Check important work.
              </p>
            </div>
          </div>

          <WorkspacePanel
            isOpen={workspaceOpen}
            currentPath={coreState.current_path}
            files={coreState.files}
            selectedFile={coreState.selected_file}
            onClose={() => setWorkspaceOpen(false)}
            onEntryClick={openFile}
            onNavigateBack={navigateToParent}
          />
        </div>
      </section>
    </main>
  );
}

function EmptyConversation({
  isReady,
  onSelectPrompt,
}: {
  isReady: boolean;
  onSelectPrompt: (prompt: string) => void;
}) {
  return (
    <section className="empty-conversation">
      <div className="empty-heading">
        <span className="hero-mark">R</span>
        <h1>What can I help you build?</h1>
        <p>
          A private workspace with an agent core that already runs in your
          browser.
        </p>
      </div>
      <div className="suggestion-grid">
        {suggestions.map(({ icon: Icon, label, prompt }) => (
          <button
            key={label}
            type="button"
            disabled={!isReady}
            onClick={() => onSelectPrompt(prompt)}
          >
            <Icon size={18} />
            <span>{label}</span>
            <ChevronRight size={16} className="suggestion-arrow" />
          </button>
        ))}
      </div>
    </section>
  );
}

function UserMessageRow({ content }: { content: string }) {
  return (
    <article className="message-row user-row">
      <div className="user-message">{content}</div>
    </article>
  );
}

function AssistantRunRow({
  entries,
  isRunActive,
}: {
  entries: Array<AssistantMessageEntry | ToolResultEntry>;
  isRunActive: boolean;
}) {
  const turns = buildAssistantRunPresentation(entries, isRunActive);

  return (
    <article className="message-row assistant-row">
      <div className="assistant-avatar">R</div>
      <div className="assistant-content">
        {turns.map((turn) => (
          <AssistantTurn
            key={turn.entry.entry_id}
            turn={turn}
            isRunActive={isRunActive}
          />
        ))}
      </div>
    </article>
  );
}

function AssistantTurn({
  turn,
  isRunActive,
}: {
  turn: AssistantTurnPresentation;
  isRunActive: boolean;
}) {
  const { entry } = turn;

  return (
    <div className="assistant-turn">
      {turn.blocks.map(({ block, is_latest_block, tool_result }) => (
        <AssistantBlockView
          key={block.block_id}
          block={block}
          entryStatus={entry.status}
          isLatestBlock={is_latest_block}
          isRunActive={isRunActive}
          toolResult={tool_result}
        />
      ))}
      {turn.waiting_state === "thinking" && <ThinkingDots />}
      {turn.waiting_state === "interrupted" && (
        <div className="response-stopped">Response interrupted.</div>
      )}
      {turn.terminal_message && (
        <div className="response-stopped">
          {turn.terminal_message}
        </div>
      )}
      {turn.action_content !== null && (
        <MessageActions content={turn.action_content} />
      )}
    </div>
  );
}

function AssistantBlockView({
  block,
  entryStatus,
  isLatestBlock,
  isRunActive,
  toolResult,
}: {
  block: AssistantBlock;
  entryStatus: AssistantMessageEntry["status"];
  isLatestBlock: boolean;
  isRunActive: boolean;
  toolResult?: ToolResultEntry;
}) {
  switch (block.type) {
    case "assistant_text":
      return block.text ? (
        <div className="assistant-text">{block.text}</div>
      ) : null;
    case "reasoning":
      if (block.redacted) {
        return (
          <div className="reasoning-redacted" role="note">
            Reasoning redacted
          </div>
        );
      }
      return block.text ? (
        <details className="reasoning-block">
          <summary>
            {entryStatus === "streaming" &&
            isRunActive &&
            isLatestBlock ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Sparkles size={14} />
            )}
            <span>
              {entryStatus === "streaming" &&
              isRunActive &&
              isLatestBlock
                ? "Thinking"
                : "Reasoned"}
            </span>
            <ChevronRight size={14} className="reasoning-chevron" />
          </summary>
          <div className="reasoning-text">{block.text}</div>
        </details>
      ) : null;
    case "tool_call":
      return (
        <ToolCallCard
          block={block}
          result={toolResult}
          isRunActive={isRunActive}
        />
      );
  }
}

function ToolCallCard({
  block,
  result,
  isRunActive,
}: {
  block: ToolCallBlock;
  result?: ToolResultEntry;
  isRunActive: boolean;
}) {
  const status = result
    ? result.is_error
      ? "error"
      : "complete"
    : isRunActive
      ? "running"
      : "error";
  const resultCopy = getToolResultCopy(result);
  const path =
    typeof block.arguments.path === "string"
      ? block.arguments.path
      : null;
  const statusLabel =
    status === "running"
      ? "Tool running"
      : status === "complete"
        ? "Tool completed"
        : "Tool failed";
  const label = block.label ?? formatToolName(block.tool_name);

  return (
    <div
      className="tool-card"
      role="status"
      aria-live="polite"
      aria-busy={status === "running"}
    >
      <span className="visually-hidden">
        {statusLabel}: {label}
      </span>
      <span className={`tool-icon ${status}`} aria-hidden="true">
        {status === "running" ? (
          <LoaderCircle size={15} className="spin" />
        ) : status === "complete" ? (
          <Check size={14} />
        ) : (
          <X size={14} />
        )}
      </span>
      <span className="tool-copy">
        <strong>{label}</strong>
        {!block.label && path && <small>{path}</small>}
        {resultCopy.summary && <small>{resultCopy.summary}</small>}
        {resultCopy.error_detail && (
          <small className="tool-error-detail">
            {resultCopy.error_detail}
          </small>
        )}
        {!result && !isRunActive && (
          <small>The tool did not return a result.</small>
        )}
        {result?.file_change && (
          <span className="tool-file-change">
            <code title={result.file_change.path}>
              {result.file_change.path}
            </code>
            <span
              className="tool-change-stats"
              aria-label={`${result.file_change.additions} additions and ${result.file_change.deletions} deletions`}
            >
              <span className="tool-additions">
                +{result.file_change.additions}
              </span>
              <span className="tool-deletions">
                −{result.file_change.deletions}
              </span>
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

function MessageActions({ content }: { content: string }) {
  return (
    <div className="message-actions">
      <button
        type="button"
        aria-label="Copy response"
        onClick={() => void navigator.clipboard.writeText(content)}
      >
        <Copy size={15} />
      </button>
      <button type="button" aria-label="Good response">
        <ThumbsUp size={15} />
      </button>
      <button type="button" aria-label="Bad response">
        <ThumbsDown size={15} />
      </button>
      <button type="button" aria-label="Regenerate response">
        <RotateCcw size={15} />
      </button>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="thinking-dots" aria-label="Thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

function formatToolName(toolName: string): string {
  const label = toolName.replaceAll("_", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function WorkspacePanel({
  isOpen,
  currentPath,
  files,
  selectedFile,
  onClose,
  onEntryClick,
  onNavigateBack,
}: {
  isOpen: boolean;
  currentPath: string;
  files: FileEntry[];
  selectedFile: { path: string; content: string } | null;
  onClose: () => void;
  onEntryClick: (entry: FileEntry) => void;
  onNavigateBack: () => void;
}) {
  return (
    <aside className={`workspace-panel ${isOpen ? "workspace-open" : ""}`}>
      <div className="workspace-header">
        <div>
          <span className="eyebrow">Virtual filesystem</span>
          <h2>Workspace</h2>
        </div>
        <button type="button" aria-label="Close workspace" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="path-bar">
        <button
          type="button"
          aria-label="Go to parent folder"
          disabled={currentPath === "/"}
          onClick={onNavigateBack}
        >
          <ChevronLeft size={16} />
        </button>
        <code>{currentPath}</code>
      </div>

      <div className="file-list">
        {files.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={selectedFile?.path === entry.path ? "selected" : ""}
            onClick={() => onEntryClick(entry)}
          >
            <span className={`file-kind ${entry.kind}`}>
              {entry.kind === "directory" ? (
                <Folder size={17} />
              ) : (
                <FileText size={17} />
              )}
            </span>
            <span className="file-name">{entry.name}</span>
            {entry.kind === "file" && <small>{formatBytes(entry.size)}</small>}
            {entry.kind === "directory" && <ChevronRight size={15} />}
          </button>
        ))}
      </div>

      {selectedFile ? (
        <div className="file-preview">
          <div className="file-preview-heading">
            <FileText size={15} />
            <span>{selectedFile.path.split("/").at(-1)}</span>
          </div>
          <pre>{selectedFile.content}</pre>
        </div>
      ) : (
        <div className="workspace-empty">
          <MessageSquareText size={20} />
          <p>Select a file to preview its contents.</p>
        </div>
      )}
    </aside>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
