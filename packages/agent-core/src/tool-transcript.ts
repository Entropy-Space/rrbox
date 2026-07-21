import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

export type ToolTranscriptRepair = {
  messages: AgentMessage[];
  repaired: boolean;
};

export function repairUnansweredToolCalls(
  messages: readonly AgentMessage[],
  errorMessage: string,
): ToolTranscriptRepair {
  const repairedMessages: AgentMessage[] = [];
  let pendingToolCalls: Map<string, ToolCall> | null = null;
  let repaired = false;

  for (const candidate of messages) {
    const message = requireStandardMessage(candidate);
    if (pendingToolCalls && message.role !== "toolResult") {
      repairedMessages.push(
        ...createMissingToolResults(pendingToolCalls, errorMessage),
      );
      pendingToolCalls = null;
      repaired = true;
    }

    if (message.role === "toolResult") {
      acceptToolResult(message, pendingToolCalls);
      repairedMessages.push(message);
      if (pendingToolCalls?.size === 0) pendingToolCalls = null;
      continue;
    }

    repairedMessages.push(message);
    if (message.role === "assistant") {
      pendingToolCalls = collectToolCalls(message.content);
    }
  }

  if (pendingToolCalls) {
    repairedMessages.push(
      ...createMissingToolResults(pendingToolCalls, errorMessage),
    );
    repaired = true;
  }

  assertCompleteToolCallResults(repairedMessages);
  return { messages: repairedMessages, repaired };
}

export function assertCompleteToolCallResults(
  messages: readonly AgentMessage[],
): void {
  let pendingToolCalls: Map<string, ToolCall> | null = null;

  for (const candidate of messages) {
    const message = requireStandardMessage(candidate);
    if (message.role === "toolResult") {
      acceptToolResult(message, pendingToolCalls);
      if (pendingToolCalls?.size === 0) pendingToolCalls = null;
      continue;
    }
    if (pendingToolCalls) {
      throw new Error("An assistant tool call is missing its tool result.");
    }
    if (message.role === "assistant") {
      pendingToolCalls = collectToolCalls(message.content);
    }
  }

  if (pendingToolCalls) {
    throw new Error("An assistant tool call is missing its tool result.");
  }
}

function collectToolCalls(
  content: AssistantMessage["content"],
): Map<string, ToolCall> | null {
  const toolCalls = new Map<string, ToolCall>();
  for (const block of content) {
    if (block.type !== "toolCall") continue;
    if (toolCalls.has(block.id)) {
      throw new Error(`Duplicate assistant tool call id: ${block.id}`);
    }
    toolCalls.set(block.id, block);
  }
  return toolCalls.size > 0 ? toolCalls : null;
}

function acceptToolResult(
  result: ToolResultMessage,
  pendingToolCalls: Map<string, ToolCall> | null,
): void {
  if (!pendingToolCalls) {
    throw new Error(`Unexpected tool result: ${result.toolCallId}`);
  }
  const toolCall = pendingToolCalls.get(result.toolCallId);
  if (!toolCall) {
    throw new Error(`Unexpected tool result: ${result.toolCallId}`);
  }
  if (result.toolName !== toolCall.name) {
    throw new Error(
      `Tool result ${result.toolCallId} names ${result.toolName}, expected ${toolCall.name}.`,
    );
  }
  pendingToolCalls.delete(result.toolCallId);
}

function createMissingToolResults(
  pendingToolCalls: ReadonlyMap<string, ToolCall>,
  errorMessage: string,
): ToolResultMessage[] {
  return [...pendingToolCalls.values()].map((toolCall) => ({
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: errorMessage }],
    isError: true,
    timestamp: Date.now(),
  }));
}

function requireStandardMessage(message: AgentMessage): Message {
  const role = (message as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") {
    throw new Error("Agent message role is not supported in a tool transcript.");
  }
  return message as Message;
}
