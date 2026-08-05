import {
  type AssistantBlock,
  type AssistantMessageEntry,
  type TimelineEntry,
  type ToolResultEntry,
  type UserMessageEntry,
  type WorkspaceChangeSummary,
} from "@researchbox/protocol";

export type TimelineRow =
  | {
      type: "user";
      entry: UserMessageEntry;
    }
  | {
      type: "assistant_run";
      run_id: string;
      entries: Array<AssistantMessageEntry | ToolResultEntry>;
    };

export type PendingPromptPresentation = {
  request_id: string;
  input_draft: string;
  created_at: string;
};

export function withPendingPrompt(
  timeline: TimelineEntry[],
  pendingPrompt: PendingPromptPresentation | null,
): TimelineEntry[] {
  if (!pendingPrompt) return timeline;

  return [
    ...timeline,
    {
      type: "user_message",
      entry_id: `pending:${pendingPrompt.request_id}`,
      run_id: `pending:${pendingPrompt.request_id}`,
      created_at: pendingPrompt.created_at,
      content: pendingPrompt.input_draft.trim(),
    },
  ];
}

export type AssistantTurnPresentation = {
  entry: AssistantMessageEntry;
  blocks: Array<{
    block: AssistantBlock;
    is_latest_block: boolean;
    tool_result?: ToolResultEntry;
  }>;
  waiting_state: "thinking" | "interrupted" | null;
  terminal_message: string | null;
  action_content: string | null;
};

export function buildTimelineRows(timeline: TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];

  for (let index = 0; index < timeline.length;) {
    const entry = timeline[index];
    if (entry.type === "user_message") {
      rows.push({ type: "user", entry });
      index += 1;
      continue;
    }

    const runEntries: Array<AssistantMessageEntry | ToolResultEntry> = [];
    const runId = entry.run_id;
    while (index < timeline.length) {
      const candidate = timeline[index];
      if (
        candidate.type === "user_message" ||
        candidate.run_id !== runId
      ) {
        break;
      }
      runEntries.push(candidate);
      index += 1;
    }
    rows.push({
      type: "assistant_run",
      run_id: runId,
      entries: runEntries,
    });
  }

  return rows;
}

export function indexToolResults(
  entries: Array<AssistantMessageEntry | ToolResultEntry>,
): ReadonlyMap<string, ToolResultEntry> {
  const results = new Map<string, ToolResultEntry>();
  for (const entry of entries) {
    if (entry.type === "tool_result") {
      results.set(entry.tool_call_block_id, entry);
    }
  }
  return results;
}

export function buildAssistantRunPresentation(
  entries: Array<AssistantMessageEntry | ToolResultEntry>,
  isRunActive: boolean,
): AssistantTurnPresentation[] {
  const toolResults = indexToolResults(entries);
  const finalAssistantEntry = findFinalAssistantEntry(entries, isRunActive);

  return entries.flatMap((entry) => {
    if (entry.type !== "assistant_message") return [];

    const hasVisibleBlocks = entry.blocks.some(isVisibleAssistantBlock);
    const waitingState =
      entry.status !== "streaming"
        ? null
        : isRunActive
          ? hasVisibleBlocks
            ? null
            : "thinking"
          : "interrupted";
    const terminalMessage =
      entry.status === "aborted"
        ? "Response stopped."
        : entry.status === "error"
          ? entry.error_message ?? "The response could not be completed."
          : null;

    return [{
      entry,
      blocks: entry.blocks.map((block, blockIndex) => ({
        block,
        is_latest_block: blockIndex === entry.blocks.length - 1,
        ...(block.type === "tool_call" &&
        toolResults.has(block.block_id)
          ? { tool_result: toolResults.get(block.block_id) }
          : {}),
      })),
      waiting_state: waitingState,
      terminal_message: terminalMessage,
      action_content:
        entry.entry_id === finalAssistantEntry?.entry_id
          ? getAssistantText(entry)
          : null,
    }];
  });
}

export function getAssistantText(entry: AssistantMessageEntry): string {
  return entry.blocks
    .filter((block) => block.type === "assistant_text")
    .map((block) => block.text)
    .join("\n\n");
}

export function getToolResultCopy(result: ToolResultEntry | undefined): {
  summary: string | null;
  error_detail: string | null;
} {
  if (!result) return { summary: null, error_detail: null };

  const summary =
    !result.is_error && result.file_change
      ? workspaceChangeActivitySummary(result.file_change)
      : result.summary ?? result.content;
  return {
    summary: summary || null,
    error_detail:
      result.is_error &&
      result.content.length > 0 &&
      result.content !== summary
        ? result.content
        : null,
  };
}

export function workspaceChangeActivitySummary(
  change: WorkspaceChangeSummary,
): string {
  const verb =
    change.change_kind === "created"
      ? "Created"
      : change.change_kind === "deleted"
        ? "Deleted"
        : "Updated";
  return `${verb} · +${change.additions} −${change.deletions}`;
}

export function findFinalAssistantEntry(
  entries: Array<AssistantMessageEntry | ToolResultEntry>,
  isRunActive: boolean,
): AssistantMessageEntry | null {
  if (isRunActive) return null;

  const assistantEntries = entries.filter(
    (entry): entry is AssistantMessageEntry =>
      entry.type === "assistant_message",
  );
  const finalEntry = assistantEntries.at(-1);
  if (
    !finalEntry ||
    finalEntry.status !== "complete" ||
    finalEntry.stop_reason === "tool_use" ||
    getAssistantText(finalEntry).length === 0
  ) {
    return null;
  }
  return finalEntry;
}

function isVisibleAssistantBlock(block: AssistantBlock): boolean {
  return block.type === "tool_call" ||
    block.type === "reasoning" && (block.redacted === true || !!block.text) ||
    block.type === "assistant_text" && !!block.text;
}
