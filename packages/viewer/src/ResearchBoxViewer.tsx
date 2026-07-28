"use client";

import type { CoreTransportFactory } from "@researchbox/client";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  FileDiff,
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
  Search,
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
  type WorkspaceChangeSummary,
} from "@researchbox/protocol";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { ChatSearchDialog } from "./ChatSearchDialog.tsx";
import { shouldFocusComposerAfterChatSearch } from "./chat-search.ts";
import {
  isModalNavigationOpen,
  MOBILE_NAVIGATION_QUERY,
} from "./navigation-state.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { isStreamingAssistantText } from "./markdown.ts";
import { ModelSelector } from "./ModelSelector.tsx";
import {
  buildAssistantRunPresentation,
  buildTimelineRows,
  getToolResultCopy,
  type AssistantTurnPresentation,
} from "./timeline-rendering.ts";
import { useAgentSession } from "./use-agent-session.ts";
import { useConversationScroll } from "./use-conversation-scroll.ts";
import {
  useWorkspaceChangeReview,
  type WorkspaceChangeReviewView,
} from "./use-workspace-change-review.ts";
import { WorkspaceChangeReview } from "./WorkspaceChangeReview.tsx";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";
import {
  workspaceChangeRevertConfirmation,
  workspaceChangeRevertGuardReason,
} from "./workspace-change-review.ts";
import {
  useWorkspaceTransfer,
  type WorkspaceTransferAdapter,
} from "./workspace-transfer.ts";

export type ResearchBoxViewerProps = {
  createTransport: CoreTransportFactory;
  workspaceTransferAdapter?: WorkspaceTransferAdapter;
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
    icon: Search,
    label: "Search the workspace",
    prompt: 'Search the workspace for "versioned JSON".',
  },
];

export function ResearchBoxViewer({
  createTransport,
  workspaceTransferAdapter,
}: ResearchBoxViewerProps) {
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
    importProject,
    exportWorkspace,
    readWorkspaceChange,
    revertWorkspaceChange,
    selectNewChat,
    selectModel,
    refreshProvider,
    renameSession,
    deleteSession,
    selectSession,
    abortRun,
    openFile,
    navigateToParent,
  } = useAgentSession(createTransport);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [isMobileViewport, setMobileViewport] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const focusComposerAfterSearchRef = useRef(false);
  const workspaceHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const {
    view: workspaceChangeReview,
    open: openChangeReview,
    close: closeChangeReview,
    retry: retryChangeReview,
    request_revert: requestChangeRevert,
    cancel_revert: cancelChangeRevert,
    confirm_revert: confirmChangeRevert,
  } = useWorkspaceChangeReview({
    active_project_id: coreState.active_project_id,
    active_session_id: coreState.active_session_id,
    read_change: readWorkspaceChange,
    revert_change: revertWorkspaceChange,
  });
  const timelineRows = useMemo(
    () => buildTimelineRows(coreState.timeline),
    [coreState.timeline],
  );
  const activeRunId = coreState.is_running
    ? coreState.timeline.at(-1)?.run_id ?? null
    : null;
  const {
    messageListRef,
    conversationContentRef,
    conversationEndRef,
    showJumpToLatest,
    handleConversationScroll,
    handleConversationKeyDown,
    handleConversationClickCapture,
    handleJumpToLatest,
    interruptJumpToLatest,
  } = useConversationScroll({
    activeProjectId: coreState.active_project_id,
    activeSessionId: coreState.active_session_id,
    timeline: coreState.timeline,
  });

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
  const closeWorkspace = useCallback(() => {
    setWorkspaceOpen(false);
    closeChangeReview();
  }, [closeChangeReview]);
  const toggleWorkspace = useCallback(() => {
    if (workspaceOpen) {
      closeWorkspace();
      return;
    }
    setWorkspaceOpen(true);
  }, [closeWorkspace, workspaceOpen]);
  const openWorkspaceChangeReview = useCallback(
    (change: WorkspaceChangeSummary, trigger: HTMLButtonElement) => {
      setWorkspaceOpen(true);
      void openChangeReview(change, trigger);
    },
    [openChangeReview],
  );
  const showWorkspaceBrowser = useCallback(() => {
    closeChangeReview({ restore_focus: false });
    requestAnimationFrame(() => workspaceHeadingRef.current?.focus());
  }, [closeChangeReview]);
  const isWorkspaceTransferDisabled =
    !coreState.is_ready ||
    isManagementPending ||
    isInputDraftPending ||
    coreState.is_running ||
    coreState.pending_prompt !== null ||
    coreState.pending_fs_list !== null ||
    coreState.pending_fs_read !== null ||
    coreState.pending_workspace_refresh !== null ||
    refreshingProviderIds.size > 0;
  const {
    notice: workspaceTransferNotice,
    isPending: isWorkspaceTransferPending,
    importWorkspace,
    exportProjectWorkspace,
    cancelWorkspaceTransfer,
    consumeImportFocusSuppression,
  } = useWorkspaceTransfer({
    adapter: workspaceTransferAdapter,
    importProject,
    exportWorkspace,
    isDisabled: isWorkspaceTransferDisabled,
  });
  const isSidebarPending =
    isManagementPending ||
    isInputDraftPending ||
    coreState.is_running ||
    coreState.pending_prompt !== null ||
    isWorkspaceTransferPending;
  const openChatSearch = useCallback(() => {
    if (!isSidebarPending) setChatSearchOpen(true);
  }, [isSidebarPending]);
  const closeChatSearch = useCallback(() => {
    setChatSearchOpen(false);
  }, []);
  const selectChatSearchResult = useCallback(
    (projectId: string, sessionId: string) => {
      focusComposerAfterSearchRef.current = true;
      setChatSearchOpen(false);
      setSidebarOpen(false);
      selectSession(projectId, sessionId);
    },
    [selectSession],
  );
  useEffect(() => {
    if (
      !shouldFocusComposerAfterChatSearch(
        focusComposerAfterSearchRef.current,
        chatSearchOpen,
        isManagementPending,
        coreState.is_ready,
      )
    ) {
      return;
    }
    focusComposerAfterSearchRef.current = false;
    composerRef.current?.focus();
  }, [chatSearchOpen, coreState.is_ready, isManagementPending]);
  const workspaceChangeRevertDisabledReason =
    workspaceChangeRevertGuardReason({
      is_core_ready: coreState.is_ready,
      is_management_pending: isManagementPending,
      is_running: coreState.is_running,
      has_pending_prompt: coreState.pending_prompt !== null,
      is_workspace_transfer_pending: isWorkspaceTransferPending,
    });
  const isWorkspaceChangeRevertDisabled =
    workspaceChangeRevertDisabledReason !== null;

  useEffect(() => {
    if (!coreState.is_ready || consumeImportFocusSuppression()) return;
    composerRef.current?.focus();
  }, [
    consumeImportFocusSuppression,
    coreState.active_project_id,
    coreState.active_session_id,
    coreState.is_ready,
  ]);

  useEffect(() => {
    const openWithKeyboard = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.shiftKey ||
        (!event.ctrlKey && !event.metaKey) ||
        event.key.toLowerCase() !== "k" ||
        isSidebarPending ||
        document.querySelector("dialog[open]")
      ) {
        return;
      }
      event.preventDefault();
      setChatSearchOpen(true);
    };
    document.addEventListener("keydown", openWithKeyboard);
    return () => document.removeEventListener("keydown", openWithKeyboard);
  }, [isSidebarPending]);

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
        inputDraft={coreState.input_draft}
        isPending={isSidebarPending}
        isWorkspaceTransferDisabled={
          isWorkspaceTransferDisabled || isWorkspaceTransferPending
        }
        onClose={closeSidebar}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onSelectProject={selectProject}
        onImportProject={
          workspaceTransferAdapter ? importWorkspace : undefined
        }
        onExportProject={
          workspaceTransferAdapter ? exportProjectWorkspace : undefined
        }
        workspaceTransferNotice={
          workspaceTransferAdapter ? workspaceTransferNotice : null
        }
        onCancelWorkspaceTransfer={
          workspaceTransferAdapter ? cancelWorkspaceTransfer : undefined
        }
        onSelectNewChat={selectNewChatAndFocus}
        onOpenChatSearch={openChatSearch}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onSelectSession={selectSession}
      />

      <ChatSearchDialog
        isOpen={chatSearchOpen}
        isPending={isSidebarPending}
        projects={coreState.projects}
        sessions={coreState.sessions}
        onClose={closeChatSearch}
        onSelectSession={selectChatSearchResult}
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
                coreState.pending_prompt !== null ||
                isWorkspaceTransferPending
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
              aria-controls="researchbox-workspace"
              onClick={toggleWorkspace}
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
                isReady={
                  coreState.is_ready &&
                  isActiveModelReady &&
                  !isWorkspaceTransferPending
                }
                onSelectPrompt={submitDraft}
              />
            ) : (
              <div
                ref={messageListRef}
                id="researchbox-message-list"
                className="message-list"
                role="log"
                aria-label="Conversation messages"
                aria-live="polite"
                aria-relevant="additions text"
                tabIndex={0}
                onScroll={handleConversationScroll}
                onKeyDown={handleConversationKeyDown}
                onClickCapture={handleConversationClickCapture}
                onPointerDown={interruptJumpToLatest}
                onWheel={interruptJumpToLatest}
              >
                <div
                  ref={conversationContentRef}
                  className="message-list-content"
                >
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
                        onReviewWorkspaceChange={
                          openWorkspaceChangeReview
                        }
                      />
                    ),
                  )}
                  <div ref={conversationEndRef} />
                </div>
              </div>
            )}

            <div className="composer-region">
              {showJumpToLatest && (
                <button
                  className="jump-to-latest"
                  type="button"
                  aria-label="Jump to latest message"
                  aria-controls="researchbox-message-list"
                  onClick={handleJumpToLatest}
                >
                  <ArrowDown size={17} aria-hidden="true" />
                </button>
              )}
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
              {coreState.workspace_recovery_notice && (
                <div
                  className="recovery-banner"
                  role="status"
                  aria-live="polite"
                >
                  {coreState.workspace_recovery_notice.message}
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
                  disabled={
                    !coreState.is_ready ||
                    isManagementPending ||
                    isWorkspaceTransferPending
                  }
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
                          isWorkspaceTransferPending ||
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
            changeReview={workspaceChangeReview}
            isChangeRevertDisabled={isWorkspaceChangeRevertDisabled}
            changeRevertDisabledReason={
              workspaceChangeRevertDisabledReason
            }
            headingRef={workspaceHeadingRef}
            onClose={closeWorkspace}
            onBackToWorkspace={showWorkspaceBrowser}
            onRetryChangeReview={() => {
              void retryChangeReview();
            }}
            onRequestChangeRevert={requestChangeRevert}
            onCancelChangeRevert={cancelChangeRevert}
            onConfirmChangeRevert={() => {
              void confirmChangeRevert();
            }}
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

type WorkspaceChangeReviewHandler = (
  change: WorkspaceChangeSummary,
  trigger: HTMLButtonElement,
) => void;

function AssistantRunRow({
  entries,
  isRunActive,
  onReviewWorkspaceChange,
}: {
  entries: Array<AssistantMessageEntry | ToolResultEntry>;
  isRunActive: boolean;
  onReviewWorkspaceChange: WorkspaceChangeReviewHandler;
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
            onReviewWorkspaceChange={onReviewWorkspaceChange}
          />
        ))}
      </div>
    </article>
  );
}

function AssistantTurn({
  turn,
  isRunActive,
  onReviewWorkspaceChange,
}: {
  turn: AssistantTurnPresentation;
  isRunActive: boolean;
  onReviewWorkspaceChange: WorkspaceChangeReviewHandler;
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
          onReviewWorkspaceChange={onReviewWorkspaceChange}
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
  onReviewWorkspaceChange,
}: {
  block: AssistantBlock;
  entryStatus: AssistantMessageEntry["status"];
  isLatestBlock: boolean;
  isRunActive: boolean;
  toolResult?: ToolResultEntry;
  onReviewWorkspaceChange: WorkspaceChangeReviewHandler;
}) {
  switch (block.type) {
    case "assistant_text":
      return block.text ? (
        <MarkdownContent
          source={block.text}
          isStreaming={isStreamingAssistantText(
            entryStatus,
            isRunActive,
            isLatestBlock,
          )}
        />
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
          onReviewWorkspaceChange={onReviewWorkspaceChange}
        />
      );
  }
}

function ToolCallCard({
  block,
  result,
  isRunActive,
  onReviewWorkspaceChange,
}: {
  block: ToolCallBlock;
  result?: ToolResultEntry;
  isRunActive: boolean;
  onReviewWorkspaceChange: WorkspaceChangeReviewHandler;
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
  const fileChange = result?.file_change;

  return (
    <div
      className="tool-card"
      aria-busy={status === "running"}
    >
      <span className="visually-hidden" role="status" aria-live="polite">
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
        {fileChange && (
          <span className="tool-file-change">
            <code title={fileChange.path}>
              {fileChange.path}
            </code>
            <span
              className="tool-change-stats"
              aria-label={`${fileChange.additions} additions and ${fileChange.deletions} deletions`}
            >
              <span className="tool-additions">
                +{fileChange.additions}
              </span>
              <span className="tool-deletions">
                −{fileChange.deletions}
              </span>
            </span>
            <button
              className="tool-review-change"
              type="button"
              aria-controls="researchbox-workspace"
              onClick={(event) =>
                onReviewWorkspaceChange(fileChange, event.currentTarget)
              }
            >
              <FileDiff size={13} aria-hidden="true" />
              <span>Review change</span>
            </button>
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
  const label = toolName.replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function WorkspacePanel({
  isOpen,
  currentPath,
  files,
  selectedFile,
  changeReview,
  isChangeRevertDisabled,
  changeRevertDisabledReason,
  headingRef,
  onClose,
  onBackToWorkspace,
  onRetryChangeReview,
  onRequestChangeRevert,
  onCancelChangeRevert,
  onConfirmChangeRevert,
  onEntryClick,
  onNavigateBack,
}: {
  isOpen: boolean;
  currentPath: string;
  files: FileEntry[];
  selectedFile: { path: string; content: string } | null;
  changeReview: WorkspaceChangeReviewView;
  isChangeRevertDisabled: boolean;
  changeRevertDisabledReason: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onBackToWorkspace: () => void;
  onRetryChangeReview: () => void;
  onRequestChangeRevert: () => void;
  onCancelChangeRevert: () => void;
  onConfirmChangeRevert: () => void;
  onEntryClick: (entry: FileEntry) => void;
  onNavigateBack: () => void;
}) {
  const reviewShellRef = useRef<HTMLDivElement | null>(null);
  const revertButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmationHeadingId = useId();
  const confirmationDescriptionId = useId();
  const isReviewMode = changeReview.phase !== "idle";
  const reviewChangeId = isReviewMode
    ? changeReview.selection.change_id
    : null;

  useEffect(() => {
    if (!isOpen || reviewChangeId === null) return;
    requestAnimationFrame(() => headingRef.current?.focus());
  }, [headingRef, isOpen, reviewChangeId]);

  useEffect(() => {
    if (
      changeReview.phase !== "ready" ||
      !changeReview.is_confirming ||
      changeReview.is_reverting
    ) {
      return;
    }
    requestAnimationFrame(() => confirmationCancelRef.current?.focus());
  }, [changeReview]);

  const cancelChangeRevert = useCallback(() => {
    onCancelChangeRevert();
    requestAnimationFrame(() => revertButtonRef.current?.focus());
  }, [onCancelChangeRevert]);

  const confirmChangeRevert = useCallback(() => {
    onConfirmChangeRevert();
    requestAnimationFrame(() => reviewShellRef.current?.focus());
  }, [onConfirmChangeRevert]);

  return (
    <aside
      id="researchbox-workspace"
      className={`workspace-panel ${isOpen ? "workspace-open" : ""} ${
        isReviewMode ? "workspace-review-open" : ""
      }`}
      inert={isOpen ? undefined : true}
      aria-hidden={!isOpen}
    >
      <div className="workspace-header">
        <div>
          <span className="eyebrow">
            {isReviewMode ? "Agent workspace edit" : "Virtual filesystem"}
          </span>
          <h2 ref={headingRef} tabIndex={-1}>
            {isReviewMode ? "Review change" : "Workspace"}
          </h2>
        </div>
        <div className="workspace-header-actions">
          {isReviewMode && (
            <button
              type="button"
              aria-label="Back to workspace"
              onClick={onBackToWorkspace}
            >
              <ChevronLeft size={18} />
            </button>
          )}
          <button
            type="button"
            aria-label="Close workspace"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {changeReview.phase === "loading" && (
        <div className="workspace-change-panel-state" role="status">
          <LoaderCircle size={20} className="spin" aria-hidden="true" />
          <strong>Loading the recorded change…</strong>
          <code>{changeReview.selection.summary.path}</code>
        </div>
      )}

      {changeReview.phase === "error" && (
        <div className="workspace-change-panel-state error" role="alert">
          <FileDiff size={20} aria-hidden="true" />
          <strong>Could not load this change</strong>
          <p>{changeReview.message}</p>
          <div className="workspace-change-panel-actions">
            <button type="button" onClick={onBackToWorkspace}>
              Back
            </button>
            <button
              className="primary"
              type="button"
              onClick={onRetryChangeReview}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {changeReview.phase === "ready" && (
        <div
          ref={reviewShellRef}
          className="workspace-change-review-shell"
          tabIndex={-1}
        >
          {changeReview.action_error && (
            <div className="workspace-change-action-error" role="alert">
              {changeReview.action_error}
            </div>
          )}
          <WorkspaceChangeReview
            change={changeReview.snapshot.change}
            isReverting={changeReview.is_reverting}
            isRevertDisabled={
              isChangeRevertDisabled || changeReview.is_confirming
            }
            revertDisabledReason={changeRevertDisabledReason}
            revertButtonRef={revertButtonRef}
            onRequestRevert={onRequestChangeRevert}
          />
          {changeReview.is_confirming && (
            <div
              className="workspace-change-confirmation"
              role="group"
              aria-labelledby={confirmationHeadingId}
            >
              <strong id={confirmationHeadingId}>
                Revert this agent change?
              </strong>
              <p id={confirmationDescriptionId}>
                {workspaceChangeRevertConfirmation(
                  changeReview.snapshot.change.change_kind,
                )}{" "}
                Later edits will never be overwritten.
              </p>
              <div className="workspace-change-confirmation-actions">
                <button
                  ref={confirmationCancelRef}
                  type="button"
                  disabled={changeReview.is_reverting}
                  aria-describedby={confirmationDescriptionId}
                  onClick={cancelChangeRevert}
                >
                  Cancel
                </button>
                <button
                  className="danger"
                  type="button"
                  disabled={changeReview.is_reverting}
                  aria-describedby={confirmationDescriptionId}
                  onClick={confirmChangeRevert}
                >
                  {changeReview.is_reverting ? (
                    <LoaderCircle
                      size={14}
                      className="spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <RotateCcw size={14} aria-hidden="true" />
                  )}
                  <span>
                    {changeReview.is_reverting
                      ? "Reverting…"
                      : "Revert now"}
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!isReviewMode && (
        <>
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
                className={
                  selectedFile?.path === entry.path ? "selected" : ""
                }
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
                {entry.kind === "file" && (
                  <small>{formatBytes(entry.size)}</small>
                )}
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
        </>
      )}
    </aside>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
