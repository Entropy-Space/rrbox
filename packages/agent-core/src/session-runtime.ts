import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  Type,
  type AssistantMessage,
  type Model,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelTransport } from "@researchbox/model-transport";
import type { SessionDocument } from "@researchbox/project-store";
import {
  PROTOCOL_VERSION,
  type ChatMessage,
  type CoreEvent,
  type ToolActivity,
  type WorkspaceChangeSummary,
} from "@researchbox/protocol";
import type {
  WorkspaceChangeMetadata,
  WorkspaceChangeRecord,
} from "@researchbox/vfs";
import { createModelStreamFn } from "./pi-stream.ts";
import { decodeAgentMessages, encodeAgentMessages } from "./session-codec.ts";
import { repairUnansweredToolCalls } from "./tool-transcript.ts";
import { WorkspaceController } from "./workspace-controller.ts";

export type CoreEventSink = (event: CoreEvent) => void;

export type SessionRuntimeOptions = {
  project_id: string;
  session_id: string;
  document: SessionDocument;
  workspace: WorkspaceController;
  model_transport: ModelTransport;
  model: Model<string>;
  system_prompt: string;
  event_sink: CoreEventSink;
  checkpoint: (
    phase: "staged" | "tool_started" | "tool_finished" | "finished",
    requestId: string,
  ) => Promise<void>;
};

type WorkspaceToolDetails = {
  summary: string;
  file_change?: WorkspaceChangeSummary;
};

type MutationToolName = "write_file" | "replace_text";

type ActiveRun = {
  request_id: string;
  assistant_message: ChatMessage;
  abort_requested: boolean;
  transcript_boundary: number;
};

export type StagedPrompt = {
  user_message: ChatMessage;
  assistant_message: ChatMessage;
};

export class SessionRuntime {
  readonly project_id: string;
  readonly session_id: string;
  private document: SessionDocument;
  private readonly workspace: WorkspaceController;
  private readonly eventSink: CoreEventSink;
  private readonly checkpoint: SessionRuntimeOptions["checkpoint"];
  private readonly agent: Agent;
  private readonly unsubscribe: () => void;
  private readonly toolLabels = new Map<string, string>();
  private readonly toolActivityIds = new Map<string, string>();
  private activeRun: ActiveRun | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(options: SessionRuntimeOptions) {
    this.project_id = options.project_id;
    this.session_id = options.session_id;
    this.document = options.document;
    this.workspace = options.workspace;
    this.eventSink = options.event_sink;
    this.checkpoint = options.checkpoint;
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.system_prompt,
        model: options.model,
        thinkingLevel: "off",
        tools: this.createTools(),
        messages: decodeAgentMessages(options.document.agent_messages),
      },
      sessionId: options.session_id,
      streamFn: createModelStreamFn(options.model_transport),
      toolExecution: "sequential",
    });
    this.unsubscribe = this.agent.subscribe((event) =>
      this.handleAgentEvent(event),
    );
  }

  get is_running(): boolean {
    return this.activeRun !== null || this.agent.state.isStreaming;
  }

  bindDocument(document: SessionDocument): void {
    if (this.is_running) {
      throw new Error("Cannot replace a session document while a run is active.");
    }
    this.document = document;
  }

  startPrompt(text: string, requestId: string): Promise<void> {
    return this.trackRun(() => this.executePrompt(text, requestId));
  }

  continueStagedPrompt(
    assistantMessageId: string,
    requestId: string,
  ): Promise<void> {
    return this.trackRun(async () => {
      const assistantMessage = this.document.messages.find(
        (message) => message.id === assistantMessageId,
      );
      if (
        !assistantMessage ||
        assistantMessage.role !== "assistant" ||
        assistantMessage.status !== "streaming"
      ) {
        throw new Error("The staged assistant message is not available.");
      }
      this.activeRun = {
        request_id: requestId,
        assistant_message: assistantMessage,
        abort_requested: false,
        transcript_boundary: this.agent.state.messages.length,
      };
      this.emit("run_state", { is_running: true }, requestId);
      await this.completePrompt(requestId, assistantMessage);
    });
  }

  abort(): void {
    if (this.activeRun) this.activeRun.abort_requested = true;
    this.agent.abort();
  }

  async stopAndWait(): Promise<void> {
    this.abort();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    await this.runPromise;
    await this.agent.waitForIdle();
  }

  dispose(): void {
    if (this.is_running) {
      throw new Error("Cannot dispose a running session.");
    }
    this.unsubscribe();
  }

  private async executePrompt(text: string, requestId: string): Promise<void> {
    const messageCount = this.document.messages.length;
    const previousInputDraft = this.document.input_draft;
    const previousAgentMessages = [...this.agent.state.messages];
    const staged = stagePrompt(this.document, text);
    this.agent.state.messages = decodeAgentMessages(
      this.document.agent_messages,
    );
    this.activeRun = {
      request_id: requestId,
      assistant_message: staged.assistant_message,
      abort_requested: false,
      transcript_boundary: this.agent.state.messages.length,
    };

    try {
      await this.checkpoint("staged", requestId);
    } catch (error) {
      this.document.messages.splice(messageCount);
      this.document.input_draft = previousInputDraft;
      this.agent.state.messages = previousAgentMessages;
      this.document.agent_messages = encodeAgentMessages(previousAgentMessages);
      this.activeRun = null;
      this.emitPersistenceError(error, requestId);
      return;
    }

    this.emit("message_added", { message: staged.user_message }, requestId);
    this.emit(
      "message_added",
      { message: staged.assistant_message },
      requestId,
    );
    this.emit("run_state", { is_running: true }, requestId);
    await this.completePrompt(requestId, staged.assistant_message);
  }

  private async completePrompt(
    requestId: string,
    assistantMessage: ChatMessage,
  ): Promise<void> {
    let status: "complete" | "aborted" | "error" = "complete";
    let errorMessage: string | undefined;
    try {
      if (this.activeRun?.abort_requested) {
        status = "aborted";
      } else {
        await this.agent.continue();
        const agentError = this.agent.state.errorMessage;
        const stopReason = latestAssistantStopReason(this.agent);
        if (this.activeRun?.abort_requested) {
          status = "aborted";
        } else if (stopReason === "length") {
          status = "error";
          errorMessage = "The model stopped because it reached its output limit.";
        } else {
          status =
            stopReason === "aborted"
              ? "aborted"
              : stopReason === "error" || agentError
                ? "error"
                : "complete";
          errorMessage = agentError;
        }
      }
    } catch (error) {
      errorMessage = toErrorMessage(error, "The agent run failed.");
      status =
        latestAssistantStopReason(this.agent) === "aborted" ||
        isAbortError(error) ||
        this.activeRun?.abort_requested
          ? "aborted"
          : "error";
    }

    try {
      this.agent.state.messages = repairUnansweredToolCalls(
        this.agent.state.messages,
        status === "aborted"
          ? "Tool execution was skipped because the run was aborted."
          : "Tool execution did not complete.",
      ).messages;
    } catch (error) {
      status = "error";
      errorMessage = toErrorMessage(error, "The model returned an invalid tool transcript.");
      this.agent.state.messages = this.agent.state.messages.slice(
        0,
        this.activeRun?.transcript_boundary ?? 0,
      );
    }
    assistantMessage.status = status;
    if (this.agent.state.messages.at(-1)?.role === "user") {
      this.agent.state.messages = [
        ...this.agent.state.messages,
        createTerminalAgentMessage(this.agent, status, errorMessage),
      ];
    }
    this.finishRunningActivities(
      assistantMessage.id,
      status === "aborted"
        ? "Tool execution was stopped"
        : "Tool execution did not complete",
      requestId,
    );
    this.toolLabels.clear();
    this.toolActivityIds.clear();
    this.document.agent_messages = encodeAgentMessages(this.agent.state.messages);
    try {
      await this.checkpoint("finished", requestId);
    } catch (error) {
      this.emitPersistenceError(error, requestId);
    }

    this.emit(
      "message_finished",
      {
        message_id: assistantMessage.id,
        status,
        ...(status === "error" && errorMessage
          ? { error_message: errorMessage }
          : {}),
      },
      requestId,
    );
    if (status === "error") {
      this.emitError(
        "agent_run_failed",
        errorMessage ?? "The agent run failed.",
        requestId,
      );
    }
    this.activeRun = null;
    this.emit("run_state", { is_running: false }, requestId);
  }

  private trackRun(operation: () => Promise<void>): Promise<void> {
    if (this.runPromise || this.is_running) {
      throw new Error("A session run is already active.");
    }
    const runPromise = operation();
    this.runPromise = runPromise.finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const run = this.activeRun;
    if (!run) return;

    if (
      event.type === "message_end" &&
      event.message.role === "toolResult" &&
      isMutationToolName(event.message.toolName)
    ) {
      this.document.agent_messages = encodeAgentMessages(
        this.agent.state.messages,
      );
      try {
        await this.checkpoint("tool_finished", run.request_id);
      } catch (error) {
        this.emitPersistenceError(error, run.request_id);
        throw error;
      }
      return;
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const textDelta = event.assistantMessageEvent.delta;
      run.assistant_message.content += textDelta;
      this.emit(
        "message_delta",
        {
          message_id: run.assistant_message.id,
          text_delta: textDelta,
        },
        run.request_id,
      );
      return;
    }

    if (event.type === "tool_execution_start") {
      const label = toolLabel(event.toolName, event.args);
      const activityId = crypto.randomUUID();
      this.toolLabels.set(event.toolCallId, label);
      this.toolActivityIds.set(event.toolCallId, activityId);
      const activity: ToolActivity = {
        activity_id: activityId,
        tool_call_id: event.toolCallId,
        message_id: run.assistant_message.id,
        tool_name: event.toolName,
        label,
        status: "running",
      };
      this.upsertActivity(activity);
      this.emit("tool_activity", { activity }, run.request_id);
      if (isMutationToolName(event.toolName)) {
        this.document.agent_messages = encodeAgentMessages(
          this.agent.state.messages,
        );
        try {
          await this.checkpoint("tool_started", run.request_id);
        } catch (error) {
          this.emitPersistenceError(error, run.request_id);
          throw error;
        }
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      const activityId = this.toolActivityIds.get(event.toolCallId);
      if (!activityId) {
        throw new Error(
          `Tool call ${event.toolCallId} is missing its activity identity.`,
        );
      }
      const details = isRecord(event.result?.details)
        ? event.result.details
        : undefined;
      const fileChange = parseWorkspaceChangeSummary(details?.file_change);
      const activity: ToolActivity = {
        activity_id: activityId,
        tool_call_id: event.toolCallId,
        message_id: run.assistant_message.id,
        tool_name: event.toolName,
        label:
          this.toolLabels.get(event.toolCallId) ??
          toolLabel(event.toolName, undefined),
        status: event.isError ? "error" : "complete",
        summary:
          typeof details?.summary === "string"
            ? details.summary
            : event.isError
              ? "Tool failed"
              : "Complete",
        ...(fileChange ? { file_change: fileChange } : {}),
      };
      this.toolLabels.delete(event.toolCallId);
      this.toolActivityIds.delete(event.toolCallId);
      this.upsertActivity(activity);
      this.emit("tool_activity", { activity }, run.request_id);
    }
  }

  private createTools(): AgentTool[] {
    const pathParameters = Type.Object({
      path: Type.String({ description: "Absolute path inside the workspace" }),
    });

    const listFiles: AgentTool<typeof pathParameters, { summary: string }> = {
      name: "list_files",
      label: "List files",
      description: "List files and directories at a workspace path.",
      parameters: pathParameters,
      execute: async (_toolCallId, params) => {
        const { entries } = await this.workspace.list(params.path);
        return {
          content: [{ type: "text", text: JSON.stringify(entries) }],
          details: { summary: `${entries.length} entries found` },
        };
      },
    };

    const readFile: AgentTool<typeof pathParameters, { summary: string }> = {
      name: "read_file",
      label: "Read file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: pathParameters,
      execute: async (_toolCallId, params) => {
        const { content } = await this.workspace.read(params.path);
        return {
          content: [{ type: "text", text: content }],
          details: { summary: `${content.split("\n").length} lines read` },
        };
      },
    };

    const writeParameters = Type.Object({
      path: Type.String({ description: "Absolute path inside the workspace" }),
      content: Type.String({ description: "Complete UTF-8 file content" }),
    });
    const writeFile: AgentTool<
      typeof writeParameters,
      WorkspaceToolDetails
    > = {
      name: "write_file",
      label: "Write file",
      description: "Create or replace a UTF-8 text file in the workspace.",
      parameters: writeParameters,
      execute: async (toolCallId, params) => {
        const write = await this.workspace.write(
          params.path,
          params.content,
          {
            change: this.createChangeMetadata(toolCallId, "write_file"),
          },
        );
        return this.fileMutationResult(write, this.activeRequestId());
      },
    };

    const replaceParameters = Type.Object({
      path: Type.String({ description: "Absolute path inside the workspace" }),
      old_text: Type.String({
        description: "Exact literal text that must occur once",
      }),
      new_text: Type.String({ description: "Replacement text" }),
    });
    const replaceText: AgentTool<
      typeof replaceParameters,
      WorkspaceToolDetails
    > = {
      name: "replace_text",
      label: "Replace text",
      description:
        "Replace one unique literal text fragment in an existing workspace file.",
      parameters: replaceParameters,
      execute: async (toolCallId, params) => {
        if (params.old_text.length === 0) {
          throw new Error("old_text must not be empty.");
        }
        if (params.old_text === params.new_text) {
          throw new Error("old_text and new_text must be different.");
        }
        const { content } = await this.workspace.read(params.path);
        const matches = countOverlappingOccurrences(content, params.old_text);
        if (matches === 0) {
          throw new Error(
            "old_text was not found. Read the file again and use exact text.",
          );
        }
        if (matches !== 1) {
          throw new Error(
            "old_text occurs more than once. Include more surrounding text so the match is unique.",
          );
        }
        const index = content.indexOf(params.old_text);
        const nextContent =
          content.slice(0, index) +
          params.new_text +
          content.slice(index + params.old_text.length);
        const write = await this.workspace.write(
          params.path,
          nextContent,
          {
            expected_content: content,
            change: this.createChangeMetadata(toolCallId, "replace_text"),
          },
        );
        return this.fileMutationResult(write, this.activeRequestId());
      },
    };

    return [listFiles, readFile, writeFile, replaceText];
  }

  private upsertActivity(activity: ToolActivity): void {
    const index = this.document.activities.findIndex(
      (candidate) => candidate.activity_id === activity.activity_id,
    );
    if (index === -1) this.document.activities.push(activity);
    else this.document.activities[index] = activity;
  }

  private activeRequestId(): string {
    const requestId = this.activeRun?.request_id;
    if (!requestId) throw new Error("No active agent run is available.");
    return requestId;
  }

  private createChangeMetadata(
    toolCallId: string,
    toolName: MutationToolName,
  ): WorkspaceChangeMetadata {
    const run = this.activeRun;
    if (!run) throw new Error("No active agent run is available.");
    return {
      change_id: crypto.randomUUID(),
      session_id: this.session_id,
      message_id: run.assistant_message.id,
      assistant_message_index: this.findAssistantMessageIndex(
        toolCallId,
        toolName,
      ),
      tool_call_id: toolCallId,
      tool_name: toolName,
      created_at: new Date().toISOString(),
    };
  }

  private findAssistantMessageIndex(
    toolCallId: string,
    toolName: MutationToolName,
  ): number {
    for (
      let index = this.agent.state.messages.length - 1;
      index >= 0;
      index -= 1
    ) {
      const message = this.agent.state.messages[index];
      if (message?.role !== "assistant") continue;
      if (
        message.content.some(
          (content) =>
            content.type === "toolCall" &&
            content.id === toolCallId &&
            content.name === toolName,
        )
      ) {
        return index;
      }
    }
    throw new Error(
      `Tool call ${toolCallId} is missing from the agent transcript.`,
    );
  }

  private fileMutationResult(
    write: Awaited<ReturnType<WorkspaceController["write"]>>,
    requestId: string,
  ): {
    content: [{ type: "text"; text: string }];
    details: WorkspaceToolDetails;
  } {
    const record = write.result.change;
    if (write.result.change_kind === "unchanged") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: write.result.path,
              change_kind: "unchanged",
            }),
          },
        ],
        details: { summary: "No changes needed" },
      };
    }
    if (!record) {
      throw new Error("The workspace mutation did not produce a change record.");
    }
    const fileChange = workspaceChangeSummary(record);
    this.emit(
      "workspace_changed",
      {
        workspace_revision: write.workspace_revision,
        change: fileChange,
      },
      requestId,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(fileChange),
        },
      ],
      details: {
        summary: changeSummary(fileChange),
        file_change: fileChange,
      },
    };
  }

  private finishRunningActivities(
    messageId: string,
    summary: string,
    requestId: string,
  ): void {
    for (const activity of this.document.activities) {
      if (activity.message_id !== messageId || activity.status !== "running") {
        continue;
      }
      activity.status = "error";
      activity.summary = summary;
      this.emit("tool_activity", { activity: { ...activity } }, requestId);
    }
  }

  private emit<T extends CoreEvent["type"]>(
    type: T,
    payload: Omit<
      Extract<CoreEvent, { type: T }>["payload"],
      "project_id" | "session_id"
    >,
    requestId?: string,
  ): void {
    this.eventSink({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      ...(requestId === undefined ? {} : { request_id: requestId }),
      type,
      payload: {
        project_id: this.project_id,
        session_id: this.session_id,
        ...payload,
      },
    } as unknown as Extract<CoreEvent, { type: T }>);
  }

  private emitError(code: string, message: string, requestId?: string): void {
    this.eventSink({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      ...(requestId === undefined ? {} : { request_id: requestId }),
      type: "error",
      payload: {
        code,
        message,
        project_id: this.project_id,
        session_id: this.session_id,
      },
    });
  }

  private emitPersistenceError(error: unknown, requestId?: string): void {
    this.emitError(
      "persistence_failed",
      toErrorMessage(error, "The session could not be saved."),
      requestId,
    );
  }
}

function latestAssistantStopReason(agent: Agent): string | undefined {
  return [...agent.state.messages]
    .reverse()
    .find((message) => message.role === "assistant")?.stopReason;
}

function createTerminalAgentMessage(
  agent: Agent,
  status: "complete" | "aborted" | "error",
  errorMessage: string | undefined,
): AssistantMessage {
  const model = agent.state.model;
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: status === "complete" ? "stop" : status,
    ...(status === "error" && errorMessage
      ? { errorMessage }
      : {}),
    timestamp: Date.now(),
  };
}

function createChatMessage(
  role: ChatMessage["role"],
  content: string,
  status: ChatMessage["status"],
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    created_at: new Date().toISOString(),
    status,
  };
}

export function stagePrompt(
  document: SessionDocument,
  text: string,
): StagedPrompt {
  const userMessage = createChatMessage("user", text, "complete");
  const assistantMessage = createChatMessage("assistant", "", "streaming");
  const stagedUserMessage: UserMessage = {
    role: "user",
    content: text,
    timestamp: Date.parse(userMessage.created_at),
  };
  const agentMessages = decodeAgentMessages(document.agent_messages);
  document.input_draft = "";
  document.messages.push(userMessage, assistantMessage);
  document.agent_messages = encodeAgentMessages([
    ...agentMessages,
    stagedUserMessage,
  ]);
  return {
    user_message: userMessage,
    assistant_message: assistantMessage,
  };
}

function toolLabel(toolName: string, args: unknown): string {
  const path = isRecord(args) && typeof args.path === "string" ? args.path : "workspace";
  switch (toolName) {
    case "read_file":
      return `Reading ${path}`;
    case "write_file":
      return `Writing ${path}`;
    case "replace_text":
      return `Editing ${path}`;
    default:
      return `Listing ${path}`;
  }
}

function isMutationToolName(value: string): value is MutationToolName {
  return value === "write_file" || value === "replace_text";
}

function countOverlappingOccurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - search.length) {
    const index = value.indexOf(search, offset);
    if (index === -1) break;
    count += 1;
    offset = index + 1;
  }
  return count;
}

function workspaceChangeSummary(
  record: WorkspaceChangeRecord,
): WorkspaceChangeSummary {
  return {
    change_id: record.change_id,
    tool_call_id: record.tool_call_id,
    path: record.path,
    change_kind: record.change_kind,
    additions: record.additions,
    deletions: record.deletions,
    byte_size: record.byte_size,
  };
}

function parseWorkspaceChangeSummary(
  value: unknown,
): WorkspaceChangeSummary | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.change_id !== "string" ||
    typeof value.tool_call_id !== "string" ||
    typeof value.path !== "string" ||
    (value.change_kind !== "created" && value.change_kind !== "updated") ||
    !isNonNegativeInteger(value.additions) ||
    !isNonNegativeInteger(value.deletions) ||
    !isNonNegativeInteger(value.byte_size)
  ) {
    return undefined;
  }
  return {
    change_id: value.change_id,
    tool_call_id: value.tool_call_id,
    path: value.path,
    change_kind: value.change_kind,
    additions: value.additions,
    deletions: value.deletions,
    byte_size: value.byte_size,
  };
}

function changeSummary(change: WorkspaceChangeSummary): string {
  const verb = change.change_kind === "created" ? "Created" : "Updated";
  return `${verb} · +${change.additions} −${change.deletions}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
