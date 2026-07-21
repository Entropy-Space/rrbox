"use client";

import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  Library,
  LoaderCircle,
  Menu,
  MessageSquareText,
  Mic,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import {
  createCommand,
  type ChatMessage,
  type CoreEvent,
  type FileEntry,
  type ToolActivity,
  type ViewerCommand,
} from "@/lib/protocol";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

type CoreState = {
  session_id: string | null;
  messages: ChatMessage[];
  files: FileEntry[];
  current_path: string;
  selected_file: { path: string; content: string } | null;
  activities: ToolActivity[];
  is_ready: boolean;
  is_running: boolean;
  error_message: string | null;
};

const initialCoreState: CoreState = {
  session_id: null,
  messages: [],
  files: [],
  current_path: "/",
  selected_file: null,
  activities: [],
  is_ready: false,
  is_running: false,
  error_message: null,
};

const recentChats = [
  "Browser-native agent design",
  "Virtual filesystem adapters",
  "Protocol event model",
  "OPFS persistence notes",
];

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

function coreReducer(state: CoreState, event: CoreEvent): CoreState {
  switch (event.type) {
    case "ready":
      return {
        ...state,
        session_id: event.payload.session_id,
        messages: event.payload.messages,
        files: event.payload.files,
        is_ready: true,
      };
    case "run_state":
      return { ...state, is_running: event.payload.is_running };
    case "message_added":
      return {
        ...state,
        error_message: null,
        messages: [...state.messages, event.payload.message],
      };
    case "message_delta":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === event.payload.message_id
            ? { ...message, content: message.content + event.payload.text_delta }
            : message,
        ),
      };
    case "message_finished":
      return {
        ...state,
        error_message: event.payload.error_message ?? state.error_message,
        messages: state.messages.map((message) =>
          message.id === event.payload.message_id
            ? { ...message, status: event.payload.status }
            : message,
        ),
      };
    case "tool_activity": {
      const exists = state.activities.some(
        (activity) =>
          activity.tool_call_id === event.payload.activity.tool_call_id,
      );
      return {
        ...state,
        activities: exists
          ? state.activities.map((activity) =>
              activity.tool_call_id === event.payload.activity.tool_call_id
                ? event.payload.activity
                : activity,
            )
          : [...state.activities, event.payload.activity],
      };
    }
    case "files_snapshot":
      return {
        ...state,
        current_path: event.payload.path,
        files: event.payload.files,
        selected_file: null,
      };
    case "file_content":
      return {
        ...state,
        selected_file: event.payload,
      };
    case "session_reset":
      return {
        ...state,
        messages: [],
        activities: [],
        is_running: false,
        error_message: null,
      };
    case "error":
      return { ...state, error_message: event.payload.message };
  }
}

export default function ResearchboxApp() {
  const [coreState, dispatch] = useReducer(coreReducer, initialCoreState);
  const [draft, setDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  const sendCommand = useCallback((command: ViewerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

  useEffect(() => {
    const worker = new Worker(
      new URL("../lib/core/core.worker.ts", import.meta.url),
      { type: "module", name: "researchbox-core" },
    );
    workerRef.current = worker;
    worker.onmessage = (message: MessageEvent<CoreEvent>) => {
      dispatch(message.data);
    };
    worker.onerror = () => {
      setTransportError("The browser core could not start. Refresh to try again.");
    };
    worker.postMessage(createCommand("bootstrap", {}));

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({
      behavior: coreState.is_running ? "smooth" : "auto",
      block: "end",
    });
  }, [coreState.messages, coreState.activities, coreState.is_running]);

  const latestAssistantId = useMemo(
    () =>
      [...coreState.messages]
        .reverse()
        .find((message) => message.role === "assistant")?.id,
    [coreState.messages],
  );

  const submitPrompt = useCallback(
    (prompt: string) => {
      const text = prompt.trim();
      if (!text || !coreState.session_id || coreState.is_running) return;
      sendCommand(
        createCommand("prompt", {
          session_id: coreState.session_id,
          text,
        }),
      );
      setDraft("");
    },
    [coreState.is_running, coreState.session_id, sendCommand],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitPrompt(draft);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitPrompt(draft);
    }
  }

  function startNewChat() {
    if (!coreState.session_id) return;
    sendCommand(
      createCommand("session_reset", { session_id: coreState.session_id }),
    );
    setSidebarOpen(false);
  }

  function abortRun() {
    if (!coreState.session_id) return;
    sendCommand(createCommand("abort", { session_id: coreState.session_id }));
  }

  function openFile(entry: FileEntry) {
    if (entry.kind === "directory") {
      sendCommand(createCommand("fs_list", { path: entry.path }));
      return;
    }
    sendCommand(createCommand("fs_read", { path: entry.path }));
  }

  function navigateToParent() {
    if (coreState.current_path === "/") return;
    const segments = coreState.current_path.split("/").filter(Boolean);
    segments.pop();
    sendCommand(
      createCommand("fs_list", {
        path: segments.length > 0 ? `/${segments.join("/")}` : "/",
      }),
    );
  }

  const hasConversation = coreState.messages.length > 0;
  const visibleError = transportError ?? coreState.error_message;

  return (
    <main className="app-shell">
      {sidebarOpen && (
        <button
          className="mobile-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-topline">
          <button
            className="brand-button"
            type="button"
            aria-label="Researchbox home"
            onClick={startNewChat}
          >
            <span className="brand-mark">R</span>
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <ChevronLeft size={18} strokeWidth={1.8} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <button type="button" onClick={startNewChat}>
            <SquarePen size={18} />
            <span>New chat</span>
          </button>
          <button type="button">
            <Search size={18} />
            <span>Search chats</span>
          </button>
          <button type="button">
            <Library size={18} />
            <span>Library</span>
          </button>
        </nav>

        <div className="sidebar-section">
          <div className="section-label">
            <span>Chats</span>
            <button type="button" aria-label="Chat options">
              <MoreHorizontal size={16} />
            </button>
          </div>
          <div className="chat-history">
            {recentChats.map((chat, index) => (
              <button
                key={chat}
                type="button"
                className={index === 0 && hasConversation ? "active" : ""}
              >
                {chat}
              </button>
            ))}
          </div>
        </div>

        <button className="profile-button" type="button">
          <span className="profile-avatar">C</span>
          <span className="profile-copy">
            <strong>Local workspace</strong>
            <small>Mock model</small>
          </span>
          <Settings size={17} />
        </button>
      </aside>

      <section className="chat-surface">
        <header className="topbar">
          <div className="topbar-leading">
            <button
              className="icon-button mobile-menu-button"
              type="button"
              aria-label="Open navigation"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <button className="model-selector" type="button">
              <span>Researchbox</span>
              <small>Pi mock</small>
              <ChevronDown size={15} />
            </button>
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
                onSelectPrompt={submitPrompt}
              />
            ) : (
              <div className="message-list" aria-live="polite">
                {coreState.messages.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    activities={
                      message.id === latestAssistantId
                        ? coreState.activities
                        : []
                    }
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
                  aria-label="Message Researchbox"
                  placeholder="Message Researchbox"
                  disabled={!coreState.is_ready}
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
                        disabled={!draft.trim() || !coreState.is_ready}
                      >
                        <ArrowUp size={18} strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <p className="composer-note">
                Researchbox can make mistakes. Check important work.
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
