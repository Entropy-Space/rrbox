import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Model } from "@earendil-works/pi-ai";
import {
  PROTOCOL_VERSION,
  type ChatMessage,
  type CoreEvent,
  type FileEntry,
  type ToolActivity,
  type ViewerCommand,
} from "../protocol";
import type { VfsEntry, VirtualFileSystem } from "../vfs";
import type { ModelTransport } from "./model-transport";
import { createModelStreamFn } from "./pi-stream";

type EventSink = (event: CoreEvent) => void;

type ActiveRun = {
  run_id: string;
  request_id: string;
  assistant_message: ChatMessage;
};

const mockModel: Model<string> = {
  id: "researchbox-mock",
  name: "Researchbox Mock",
  api: "researchbox-mock",
  provider: "researchbox",
  baseUrl: "/api/mock",
  reasoning: false,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

export class AgentCore {
  private readonly sessionId = crypto.randomUUID();
  private readonly messages: ChatMessage[] = [];
  private readonly agent: Agent;
  private readonly toolLabels = new Map<string, string>();
  private activeRun: ActiveRun | null = null;
  private pendingReset: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspace: VirtualFileSystem,
    modelTransport: ModelTransport,
    private readonly eventSink: EventSink,
  ) {
    this.agent = new Agent({
      initialState: {
        systemPrompt:
          "You are Researchbox, a careful coding and research agent working inside a browser-native virtual filesystem.",
        model: mockModel,
        thinkingLevel: "off",
        tools: this.createTools(),
        messages: [],
      },
      sessionId: this.sessionId,
      streamFn: createModelStreamFn(modelTransport),
      toolExecution: "sequential",
    });
    this.agent.subscribe((event) => this.handleAgentEvent(event));
  }

  async handle(command: ViewerCommand): Promise<void> {
    switch (command.type) {
      case "bootstrap":
        this.emit(
          "ready",
          {
            session_id: this.sessionId,
            messages: this.messages,
            files: mapEntries(await this.workspace.list("/")),
          },
          command.request_id,
        );
        return;
      case "prompt":
        await this.runPrompt(command);
        return;
      case "abort":
        if (!this.validateSession(command.payload.session_id, command.request_id)) {
          return;
        }
        this.agent.abort();
        return;
      case "session_reset":
        if (!this.validateSession(command.payload.session_id, command.request_id)) {
          return;
        }
        this.resetSession(command.request_id);
        return;
      case "fs_list":
        await this.listFiles(command.payload.path, command.request_id);
        return;
      case "fs_read":
        await this.readFile(command.payload.path, command.request_id);
        return;
    }
  }

  reportProtocolError(message: string, requestId?: string): void {
    this.emit("error", { code: "invalid_command", message }, requestId);
  }

  private async runPrompt(
    command: Extract<ViewerCommand, { type: "prompt" }>,
  ): Promise<void> {
    if (!this.validateSession(command.payload.session_id, command.request_id)) {
      return;
    }
    await this.pendingReset;
    if (this.activeRun || this.agent.state.isStreaming) {
      this.emit(
        "error",
        {
          code: "run_in_progress",
          message: "Wait for the current response to finish.",
        },
        command.request_id,
      );
      return;
    }

    const userMessage = createMessage("user", command.payload.text, "complete");
    const assistantMessage = createMessage("assistant", "", "streaming");
    this.messages.push(userMessage, assistantMessage);
    this.activeRun = {
      run_id: crypto.randomUUID(),
      request_id: command.request_id,
      assistant_message: assistantMessage,
    };
    const runId = this.activeRun.run_id;

    this.emit("message_added", { message: userMessage }, command.request_id);
    this.emit("message_added", { message: assistantMessage }, command.request_id);
    this.emit("run_state", { is_running: true }, command.request_id);

    try {
      await this.agent.prompt(command.payload.text);
      if (this.activeRun?.run_id !== runId) return;

      const errorMessage = this.agent.state.errorMessage;
      const piStatus = latestAssistantStopReason(this.agent);
      const status =
        piStatus === "aborted"
          ? "aborted"
          : piStatus === "error" || errorMessage
            ? "error"
            : "complete";
      assistantMessage.status = status;
      this.emit(
        "message_finished",
        {
          message_id: assistantMessage.id,
          status,
          ...(errorMessage ? { error_message: errorMessage } : {}),
        },
        command.request_id,
      );
      if (status === "error") {
        this.emit(
          "error",
          {
            code: "model_transport_failed",
            message: errorMessage ?? "The model transport failed.",
          },
          command.request_id,
        );
      }
    } finally {
      if (this.activeRun?.run_id === runId) {
        this.activeRun = null;
        this.emit("run_state", { is_running: false }, command.request_id);
      }
    }
  }

  private resetSession(requestId: string): void {
    this.agent.abort();
    this.activeRun = null;
    this.messages.length = 0;
    this.emit("run_state", { is_running: false }, requestId);
    this.emit("session_reset", { session_id: this.sessionId }, requestId);

    this.pendingReset = this.agent.waitForIdle().then(() => {
      this.agent.reset();
    });
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
      this.emit(
        "tool_activity",
        {
          activity: {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            label,
            status: "running",
          },
        },
        run.request_id,
      );
      return;
    }

    if (event.type === "tool_execution_end") {
      const details = isRecord(event.result?.details)
        ? event.result.details
        : undefined;
      const activity: ToolActivity = {
        tool_call_id: event.toolCallId,
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

  private async listFiles(path: string, requestId: string): Promise<void> {
    try {
      this.emit(
        "files_snapshot",
        { path, files: mapEntries(await this.workspace.list(path)) },
        requestId,
      );
    } catch (error) {
      this.emitFileError("fs_list_failed", error, requestId);
    }
  }

  private async readFile(path: string, requestId: string): Promise<void> {
    try {
      this.emit(
        "file_content",
        { path, content: await this.workspace.read(path) },
        requestId,
      );
    } catch (error) {
      this.emitFileError("fs_read_failed", error, requestId);
    }
  }

  private emitFileError(
    code: "fs_list_failed" | "fs_read_failed",
    error: unknown,
    requestId: string,
  ): void {
    this.emit(
      "error",
      {
        code,
        message: error instanceof Error ? error.message : "Filesystem operation failed.",
      },
      requestId,
    );
  }

  private validateSession(sessionId: string, requestId: string): boolean {
    if (sessionId === this.sessionId) return true;
    this.emit(
      "error",
      {
        code: "session_not_found",
        message: "The requested session is not active.",
      },
      requestId,
    );
    return false;
  }

  private emit<T extends CoreEvent["type"]>(
    type: T,
    payload: Extract<CoreEvent, { type: T }>["payload"],
    requestId?: string,
  ): void {
    this.eventSink({
      protocol_version: PROTOCOL_VERSION,
      event_id: crypto.randomUUID(),
      request_id: requestId,
      type,
      payload,
    } as Extract<CoreEvent, { type: T }>);
  }
}

function latestAssistantStopReason(agent: Agent): string | undefined {
  return [...agent.state.messages]
    .reverse()
    .find((message) => message.role === "assistant")?.stopReason;
}

function createMessage(
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

function mapEntries(entries: VfsEntry[]): FileEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function toolLabel(toolName: string, args: unknown): string {
  const path = isRecord(args) && typeof args.path === "string" ? args.path : "workspace";
  return toolName === "read_file" ? `Reading ${path}` : `Listing ${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
