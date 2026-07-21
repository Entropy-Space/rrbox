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
} from "@researchbox/protocol";
import type { VirtualFileSystem } from "@researchbox/vfs";
import { createModelStreamFn } from "./pi-stream.ts";
import { decodeAgentMessages, encodeAgentMessages } from "./session-codec.ts";

export type CoreEventSink = (event: CoreEvent) => void;

export type SessionRuntimeOptions = {
  project_id: string;
  session_id: string;
  document: SessionDocument;
  workspace: VirtualFileSystem;
  model_transport: ModelTransport;
  model: Model<string>;
  system_prompt: string;
  event_sink: CoreEventSink;
  checkpoint: (
    phase: "staged" | "finished",
    requestId: string,
  ) => Promise<void>;
};

type ActiveRun = {
  request_id: string;
  assistant_message: ChatMessage;
  abort_requested: boolean;
};

export type StagedPrompt = {
  user_message: ChatMessage;
  assistant_message: ChatMessage;
};

export class SessionRuntime {
  readonly project_id: string;
  readonly session_id: string;
  private document: SessionDocument;
  private readonly workspace: VirtualFileSystem;
  private readonly eventSink: CoreEventSink;
  private readonly checkpoint: SessionRuntimeOptions["checkpoint"];
  private readonly agent: Agent;
  private readonly unsubscribe: () => void;
  private readonly toolLabels = new Map<string, string>();
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
    this.unsubscribe = this.agent.subscribe((event) => {
      this.handleAgentEvent(event);
    });
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
        status =
          stopReason === "aborted"
            ? "aborted"
            : stopReason === "error" || agentError
              ? "error"
              : "complete";
        errorMessage = agentError;
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

    assistantMessage.status = status;
    if (this.agent.state.messages.at(-1)?.role === "user") {
      this.agent.state.messages = [
        ...this.agent.state.messages,
        createTerminalAgentMessage(this.agent, status, errorMessage),
      ];
    }
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

  private handleAgentEvent(event: AgentEvent): void {
    const run = this.activeRun;
    if (!run) return;

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
      this.toolLabels.set(event.toolCallId, label);
      const activity: ToolActivity = {
        tool_call_id: event.toolCallId,
        message_id: run.assistant_message.id,
        tool_name: event.toolName,
        label,
        status: "running",
      };
      this.upsertActivity(activity);
      this.emit("tool_activity", { activity }, run.request_id);
      return;
    }

    if (event.type === "tool_execution_end") {
      const details = isRecord(event.result?.details)
        ? event.result.details
        : undefined;
      const activity: ToolActivity = {
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
      };
      this.toolLabels.delete(event.toolCallId);
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
        const entries = await this.workspace.list(params.path);
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
        const content = await this.workspace.read(params.path);
        return {
          content: [{ type: "text", text: content }],
          details: { summary: `${content.split("\n").length} lines read` },
        };
      },
    };

    return [listFiles, readFile];
  }

  private upsertActivity(activity: ToolActivity): void {
    const index = this.document.activities.findIndex(
      (candidate) => candidate.tool_call_id === activity.tool_call_id,
    );
    if (index === -1) this.document.activities.push(activity);
    else this.document.activities[index] = activity;
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
  return toolName === "read_file" ? `Reading ${path}` : `Listing ${path}`;
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
