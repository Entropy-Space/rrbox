"use client";

import { ChevronDown, GitBranch, History, X } from "lucide-react";
import type {
  SessionHistoryNodeSummary,
  SessionHistorySnapshot,
} from "@researchbox/protocol";

export type ConversationHistoryProps = {
  history?: SessionHistorySnapshot;
  is_open: boolean;
  is_pending: boolean;
  is_running: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNavigate: (targetNodeId: string | null) => void;
};

export function ConversationHistory({
  history,
  is_open,
  is_pending,
  is_running,
  onToggle,
  onClose,
  onNavigate,
}: ConversationHistoryProps) {
  const nodes = history?.nodes ?? [];
  if (nodes.length === 0) return null;

  const navigationDisabled = is_pending || is_running;
  return (
    <div className="conversation-history">
      <button
        className={`conversation-history-toggle ${is_open ? "active" : ""}`}
        type="button"
        aria-label="Conversation history"
        aria-expanded={is_open}
        aria-haspopup="dialog"
        onClick={onToggle}
      >
        <History size={16} aria-hidden="true" />
        <span>History</span>
        <span className="conversation-history-count">{nodes.length}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {is_open && (
        <div
          className="conversation-history-popover"
          role="dialog"
          aria-label="Conversation history"
        >
          <div className="conversation-history-header">
            <div>
              <strong>Conversation history</strong>
              <span>Choose a response checkpoint</span>
            </div>
            <button
              className="conversation-history-close"
              type="button"
              aria-label="Close conversation history"
              onClick={onClose}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <div className="conversation-history-list" role="listbox">
            <button
              className={`conversation-history-node ${
                history?.active_leaf_id === null ? "selected" : ""
              }`}
              type="button"
              role="option"
              aria-selected={history?.active_leaf_id === null}
              disabled={navigationDisabled || history?.active_leaf_id === null}
              onClick={() => {
                onNavigate(null);
                onClose();
              }}
            >
              <span
                className="conversation-history-node-marker"
                aria-hidden="true"
              />
              <span className="conversation-history-node-copy">
                <strong>Start of conversation</strong>
                <small>Empty checkpoint</small>
              </span>
            </button>
            {nodes.map((node, index) => (
              <HistoryNode
                key={node.node_id}
                node={node}
                is_branch={
                  index > 0 && node.parent_node_id !== nodes[index - 1].node_id
                }
                is_selected={node.node_id === history?.active_leaf_id}
                is_disabled={
                  navigationDisabled || node.entry_type === "user_message"
                }
                onNavigate={() => {
                  onNavigate(node.node_id);
                  onClose();
                }}
              />
            ))}
          </div>
          <p className="conversation-history-note">
            Workspace files stay unchanged when you switch conversation
            checkpoints.
          </p>
        </div>
      )}
    </div>
  );
}

function HistoryNode({
  node,
  is_branch,
  is_selected,
  is_disabled,
  onNavigate,
}: {
  node: SessionHistoryNodeSummary;
  is_branch: boolean;
  is_selected: boolean;
  is_disabled: boolean;
  onNavigate: () => void;
}) {
  return (
    <button
      className={`conversation-history-node ${
        is_selected ? "selected" : ""
      } ${is_branch ? "branch" : ""}`}
      type="button"
      role="option"
      aria-selected={is_selected}
      disabled={is_disabled}
      title={
        node.entry_type === "user_message"
          ? "Select a response checkpoint to continue from this branch."
          : undefined
      }
      onClick={onNavigate}
    >
      <span className="conversation-history-node-marker" aria-hidden="true">
        {is_branch && <GitBranch size={13} />}
      </span>
      <span className="conversation-history-node-copy">
        <strong>{node.preview || describeEntryType(node.entry_type)}</strong>
        <small>
          {describeEntryType(node.entry_type)} ·{" "}
          {formatCheckpointTime(node.created_at)}
        </small>
      </span>
      {is_selected && (
        <span className="conversation-history-current">Current</span>
      )}
    </button>
  );
}

function describeEntryType(
  entryType: SessionHistoryNodeSummary["entry_type"],
): string {
  switch (entryType) {
    case "user_message":
      return "Prompt";
    case "assistant_message":
      return "Response";
    case "tool_result":
      return "Tool result";
  }
}

function formatCheckpointTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown time";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
