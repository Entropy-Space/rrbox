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
  type ChatMessage,
  type FileEntry,
  type ToolActivity,
} from "@researchbox/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  isModalNavigationOpen,
  MOBILE_NAVIGATION_QUERY,
} from "./navigation-state.ts";
import { useAgentSession } from "./use-agent-session.ts";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";

export type ResearchBoxViewerProps = {
  createWorker: () => Worker;
};

const suggestions = [
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
    submitPrompt,
    createProject,
    renameProject,
    deleteProject,
    selectProject,
    createSession,
    renameSession,
    deleteSession,
    selectSession,
    abortRun,
    openFile,
    navigateToParent,
  } = useAgentSession(createWorker);
  const [draftState, setDraftState] = useState<{
    session_id: string | null;
    value: string;
  }>({ session_id: null, value: "" });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobileViewport, setMobileViewport] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({
      behavior: coreState.is_running ? "smooth" : "auto",
      block: "end",
    });
  }, [coreState.messages, coreState.activities, coreState.is_running]);

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

  const draft =
    draftState.session_id === coreState.active_session_id
      ? draftState.value
      : "";
  const setDraft = useCallback(
    (value: string) => {
      setDraftState({
        session_id: coreState.active_session_id,
        value,
      });
    },
    [coreState.active_session_id],
  );

  const submitDraft = useCallback(
    (prompt: string) => {
      if (submitPrompt(prompt)) setDraft("");
    },
    [setDraft, submitPrompt],
  );
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitDraft(draft);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitDraft(draft);
    }
  }

  const hasConversation = coreState.messages.length > 0;
  const visibleError = transportError ?? coreState.error_message;
  const activeProject = coreState.projects.find(
    (project) => project.project_id === coreState.active_project_id,
  );
  const activeSession = coreState.sessions.find(
    (session) => session.session_id === coreState.active_session_id,
  );
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
        isPending={isManagementPending || coreState.is_running}
        onClose={closeSidebar}
        onCreateProject={createProject}
        onRenameProject={renameProject}
        onDeleteProject={deleteProject}
        onSelectProject={selectProject}
        onCreateSession={createSession}
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
            <div className="model-selector" aria-label="Active workspace">
              <span>ResearchBox</span>
              <small>
                {activeProject?.name ?? "Loading"}
                {activeSession ? ` · ${activeSession.title}` : ""}
              </small>
            </div>
          </div>
          <div className="topbar-actions">
            <span
              className={`core-status ${coreState.is_ready ? "online" : ""}`}
              title={coreState.is_ready ? "Browser core ready" : "Starting browser core"}
            >
              <span />
              {coreState.is_ready ? "Local core" : "Starting"}
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
                isReady={coreState.is_ready}
                onSelectPrompt={submitDraft}
              />
            ) : (
              <div className="message-list" aria-live="polite">
                {coreState.messages.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    activities={coreState.activities.filter(
                      (activity) => activity.message_id === message.id,
                    )}
                  />
                ))}
                <div ref={conversationEndRef} />
              </div>
            )}

            <div className="composer-region">
              {visibleError && <div className="error-banner">{visibleError}</div>}
              <form className="composer" onSubmit={handleSubmit}>
                <textarea
                  value={draft}
                  rows={1}
                  aria-label="Message ResearchBox"
                  placeholder="Message ResearchBox"
                  disabled={!coreState.is_ready || isManagementPending}
                  onChange={(event) => setDraft(event.target.value)}
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
                          !draft.trim() ||
                          !coreState.is_ready ||
                          isManagementPending
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

function MessageRow({
  message,
  activities,
}: {
  message: ChatMessage;
  activities: ToolActivity[];
}) {
  if (message.role === "user") {
    return (
      <article className="message-row user-row">
        <div className="user-message">{message.content}</div>
      </article>
    );
  }

  return (
    <article className="message-row assistant-row">
      <div className="assistant-avatar">R</div>
      <div className="assistant-content">
        {activities.length > 0 && (
          <div className="tool-stack">
            {activities.map((activity) => (
              <div className="tool-card" key={activity.tool_call_id}>
                <span className={`tool-icon ${activity.status}`}>
                  {activity.status === "running" ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Check size={14} />
                  )}
                </span>
                <span>
                  <strong>{activity.label}</strong>
                  {activity.summary && <small>{activity.summary}</small>}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="assistant-text">
          {message.content || (message.status === "aborted" ? (
            <span className="response-stopped">Response stopped.</span>
          ) : message.status === "error" ? (
            <span className="response-stopped">The response could not be completed.</span>
          ) : (
            <span className="thinking-dots" aria-label="Thinking">
              <i />
              <i />
              <i />
            </span>
          ))}
        </div>
        {message.status === "complete" && message.content && (
          <div className="message-actions">
            <button
              type="button"
              aria-label="Copy response"
              onClick={() => void navigator.clipboard.writeText(message.content)}
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
        )}
      </div>
    </article>
  );
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
