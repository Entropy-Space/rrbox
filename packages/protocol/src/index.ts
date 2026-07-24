export const PROTOCOL_VERSION = 9 as const;

export type FileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
};

export type WorkspaceTransferFile = {
  path: string;
  content: string;
};

export type WorkspaceChangeSummary = {
  change_id: string;
  tool_call_id: string;
  path: string;
  change_kind: "created" | "updated";
  additions: number;
  deletions: number;
  byte_size: number;
};

export type WorkspaceChangeRevertStatus =
  | "available"
  | "already_reverted"
  | "conflict";

export type WorkspaceChangeDetails = WorkspaceChangeSummary & {
  before_content: string | null;
  after_content: string;
  current_content: string | null;
  reverted_at_workspace_revision: number | null;
  revert_status: WorkspaceChangeRevertStatus;
};

export type AssistantUsage = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
  };
};

export type AssistantTextBlock = {
  type: "assistant_text";
  block_id: string;
  text: string;
  text_signature?: string;
};

export type ReasoningBlock = {
  type: "reasoning";
  block_id: string;
  text: string;
  thinking_signature?: string;
  redacted?: boolean;
};

export type ToolCallBlock = {
  type: "tool_call";
  block_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  thought_signature?: string;
  label?: string;
};

export type AssistantBlock =
  | AssistantTextBlock
  | ReasoningBlock
  | ToolCallBlock;

type TimelineEntryBase<TType extends string> = {
  type: TType;
  entry_id: string;
  run_id: string;
  created_at: string;
};

export type UserMessageEntry = TimelineEntryBase<"user_message"> & {
  content: string;
};

export type AssistantMessageStatus =
  | "streaming"
  | "complete"
  | "aborted"
  | "error";

export type AssistantStopReason =
  | "stop"
  | "length"
  | "tool_use"
  | "error"
  | "aborted";

export type AssistantMessageEntry =
  TimelineEntryBase<"assistant_message"> & {
    status: AssistantMessageStatus;
    api: string;
    provider: string;
    model: string;
    response_model?: string;
    response_id?: string;
    usage: AssistantUsage;
    stop_reason?: AssistantStopReason;
    error_message?: string;
    blocks: AssistantBlock[];
  };

export type ToolResultEntry = TimelineEntryBase<"tool_result"> & {
  tool_call_block_id: string;
  tool_call_id: string;
  tool_name: string;
  content: string;
  is_error: boolean;
  summary?: string;
  file_change?: WorkspaceChangeSummary;
};

export type TimelineEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | ToolResultEntry;

export type ProjectSummary = {
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type SessionSummary = {
  session_id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
};

export type ModelSelection = {
  provider_id: string;
  model_id: string;
};

export type ModelSummary = ModelSelection & {
  display_name: string;
  availability: "ready" | "unavailable";
  status_message?: string;
};

export type ProviderSummary = {
  provider_id: string;
  display_name: string;
  kind: "mock" | "openai_compatible";
  availability: "loading" | "ready" | "unavailable";
  status_message?: string;
  models: ModelSummary[];
};

export type CoreLifecyclePhase =
  | "electing"
  | "waiting_for_writer"
  | "initializing_workspace"
  | "ready"
  | "failed";

export type CoreStateSnapshot = {
  state_revision: number;
  catalog_revision: number;
  workspace_revision: number;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  providers: ProviderSummary[];
  active_model: ModelSelection;
  active_project_id: string;
  active_session_id: string | null;
  input_draft: string;
  timeline: TimelineEntry[];
  files: FileEntry[];
  is_running: boolean;
};

type CommandEnvelope<TType extends string, TPayload extends object> = {
  protocol_version: typeof PROTOCOL_VERSION;
  request_id: string;
  type: TType;
  payload: TPayload;
};

export type ViewerCommand =
  | CommandEnvelope<"bootstrap", Record<string, never>>
  | CommandEnvelope<"project_create", { name: string }>
  | CommandEnvelope<
      "project_import",
      { name: string; files: WorkspaceTransferFile[] }
    >
  | CommandEnvelope<"project_update", { project_id: string; name: string }>
  | CommandEnvelope<"project_delete", { project_id: string }>
  | CommandEnvelope<"project_select", { project_id: string }>
  | CommandEnvelope<"new_chat", { project_id: string }>
  | CommandEnvelope<
      "model_select",
      {
        project_id: string;
        session_id: string | null;
        provider_id: string;
        model_id: string;
      }
    >
  | CommandEnvelope<"provider_refresh", { provider_id: string }>
  | CommandEnvelope<
      "session_update",
      { project_id: string; session_id: string; title: string }
    >
  | CommandEnvelope<
      "session_delete",
      { project_id: string; session_id: string }
    >
  | CommandEnvelope<
      "session_select",
      { project_id: string; session_id: string }
    >
  | CommandEnvelope<
      "prompt",
      { project_id: string; session_id: string | null; text: string }
    >
  | CommandEnvelope<
      "input_draft_update",
      { project_id: string; session_id: string | null; input_draft: string }
    >
  | CommandEnvelope<
      "abort",
      { project_id: string; session_id: string }
    >
  | CommandEnvelope<"workspace_export", { project_id: string }>
  | CommandEnvelope<
      "workspace_export_cancel",
      { target_request_id: string }
    >
  | CommandEnvelope<
      "workspace_change_read",
      { project_id: string; change_id: string }
    >
  | CommandEnvelope<
      "workspace_change_revert",
      { project_id: string; change_id: string }
    >
  | CommandEnvelope<"fs_list", { project_id: string; path: string }>
  | CommandEnvelope<"fs_read", { project_id: string; path: string }>;

type EventEnvelope<TType extends string, TPayload extends object> = {
  protocol_version: typeof PROTOCOL_VERSION;
  event_id: string;
  request_id?: string;
  type: TType;
  payload: TPayload;
};

type CorrelatedEventEnvelope<TType extends string, TPayload extends object> =
  Omit<EventEnvelope<TType, TPayload>, "request_id"> & {
    request_id: string;
  };

type SessionScope = {
  project_id: string;
  session_id: string;
};

export type CoreEvent =
  | EventEnvelope<
      "core_lifecycle",
      { phase: CoreLifecyclePhase; status_message?: string }
    >
  | EventEnvelope<
      "provider_catalog_snapshot",
      { catalog_revision: number; providers: ProviderSummary[] }
    >
  | EventEnvelope<"ready", { state: CoreStateSnapshot }>
  | EventEnvelope<"state_snapshot", { state: CoreStateSnapshot }>
  | EventEnvelope<"run_state", SessionScope & { is_running: boolean }>
  | EventEnvelope<
      "timeline_entry_appended",
      SessionScope & { entry: TimelineEntry }
    >
  | EventEnvelope<
      "assistant_block_appended",
      SessionScope & { entry_id: string; block: AssistantBlock }
    >
  | EventEnvelope<
      "assistant_block_delta",
      SessionScope & {
        entry_id: string;
        block_id: string;
        block_type: "assistant_text" | "reasoning";
        text_delta: string;
      }
    >
  | EventEnvelope<
      "timeline_entry_updated",
      SessionScope & { entry: TimelineEntry }
    >
  | EventEnvelope<
      "assistant_block_updated",
      SessionScope & { entry_id: string; block: AssistantBlock }
    >
  | EventEnvelope<
      "workspace_changed",
      SessionScope & {
        workspace_revision: number;
        change: WorkspaceChangeSummary;
      }
    >
  | CorrelatedEventEnvelope<
      "files_snapshot",
      {
        project_id: string;
        path: string;
        workspace_revision: number;
        files: FileEntry[];
      }
    >
  | CorrelatedEventEnvelope<
      "file_content",
      {
        project_id: string;
        path: string;
        workspace_revision: number;
        content: string;
      }
    >
  | CorrelatedEventEnvelope<
      "input_draft_saved",
      { project_id: string; session_id: string | null; input_draft: string }
    >
  | CorrelatedEventEnvelope<
      "workspace_export_snapshot",
      {
        project_id: string;
        project_name: string;
        workspace_revision: number;
        files: WorkspaceTransferFile[];
      }
    >
  | CorrelatedEventEnvelope<
      "workspace_change_snapshot",
      {
        project_id: string;
        workspace_revision: number;
        change: WorkspaceChangeDetails;
      }
    >
  | CorrelatedEventEnvelope<
      "workspace_change_reverted",
      {
        project_id: string;
        change_id: string;
        path: string;
        change_kind: "created" | "updated";
        workspace_revision: number;
        reverted_at_workspace_revision: number;
        revert_outcome: "applied" | "already_reverted";
      }
    >
  | EventEnvelope<
      "error",
      {
        code: string;
        message: string;
        project_id?: string;
        session_id?: string;
      }
    >;

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function createCommand<T extends ViewerCommand["type"]>(
  type: T,
  payload: Extract<ViewerCommand, { type: T }>["payload"],
): Extract<ViewerCommand, { type: T }> {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: createRequestId(),
    type,
    payload,
  } as Extract<ViewerCommand, { type: T }>;
}

export function parseViewerCommand(value: unknown): ViewerCommand {
  if (!isRecord(value)) throw new Error("Command must be an object.");
  if (value.protocol_version !== PROTOCOL_VERSION) {
    throw new Error("Unsupported protocol version.");
  }
  const requestId = requireString(value, "request_id");
  if (typeof value.type !== "string" || !isRecord(value.payload)) {
    throw new Error("Command type and payload are required.");
  }

  const payload = value.payload;
  switch (value.type) {
    case "bootstrap":
      return commandEnvelope("bootstrap", requestId, {});
    case "project_create":
      return commandEnvelope("project_create", requestId, {
        name: requireString(payload, "name"),
      });
    case "project_import":
      assertExactKeys(payload, ["name", "files"], "project_import payload");
      return commandEnvelope("project_import", requestId, {
        name: requireString(payload, "name"),
        files: parseWorkspaceTransferFiles(payload.files),
      });
    case "project_update":
      return commandEnvelope("project_update", requestId, {
        project_id: requireString(payload, "project_id"),
        name: requireString(payload, "name"),
      });
    case "project_delete":
      return commandEnvelope("project_delete", requestId, {
        project_id: requireString(payload, "project_id"),
      });
    case "project_select":
      return commandEnvelope("project_select", requestId, {
        project_id: requireString(payload, "project_id"),
      });
    case "new_chat":
      return commandEnvelope("new_chat", requestId, {
        project_id: requireString(payload, "project_id"),
      });
    case "model_select":
      return commandEnvelope("model_select", requestId, {
        project_id: requireString(payload, "project_id"),
        session_id: requireNullableString(payload, "session_id"),
        provider_id: requireString(payload, "provider_id"),
        model_id: requireString(payload, "model_id"),
      });
    case "provider_refresh":
      return commandEnvelope("provider_refresh", requestId, {
        provider_id: requireString(payload, "provider_id"),
      });
    case "session_update":
      return commandEnvelope("session_update", requestId, {
        project_id: requireString(payload, "project_id"),
        session_id: requireString(payload, "session_id"),
        title: requireString(payload, "title"),
      });
    case "session_delete":
      return commandEnvelope("session_delete", requestId, {
        project_id: requireString(payload, "project_id"),
        session_id: requireString(payload, "session_id"),
      });
    case "session_select":
      return commandEnvelope("session_select", requestId, {
        project_id: requireString(payload, "project_id"),
        session_id: requireString(payload, "session_id"),
      });
    case "prompt":
      return commandEnvelope("prompt", requestId, {
        project_id: requireString(payload, "project_id"),
        session_id: requireNullableString(payload, "session_id"),
        text: requireString(payload, "text"),
      });
    case "input_draft_update":
      return commandEnvelope("input_draft_update", requestId, {
        project_id: requireString(payload, "project_id"),
        session_id: requireNullableString(payload, "session_id"),
        input_draft: requireString(payload, "input_draft", true),
      });
    case "abort":
      return commandEnvelope("abort", requestId, {
        project_id: requireString(payload, "project_id"),
        session_id: requireString(payload, "session_id"),
      });
    case "workspace_export":
      assertExactKeys(
        payload,
        ["project_id"],
        "workspace_export payload",
      );
      return commandEnvelope("workspace_export", requestId, {
        project_id: requireString(payload, "project_id"),
      });
    case "workspace_export_cancel":
      assertExactKeys(
        payload,
        ["target_request_id"],
        "workspace_export_cancel payload",
      );
      return commandEnvelope("workspace_export_cancel", requestId, {
        target_request_id: requireString(payload, "target_request_id"),
      });
    case "workspace_change_read":
      assertExactKeys(
        payload,
        ["project_id", "change_id"],
        "workspace_change_read payload",
      );
      return commandEnvelope("workspace_change_read", requestId, {
        project_id: requireString(payload, "project_id"),
        change_id: requireString(payload, "change_id"),
      });
    case "workspace_change_revert":
      assertExactKeys(
        payload,
        ["project_id", "change_id"],
        "workspace_change_revert payload",
      );
      return commandEnvelope("workspace_change_revert", requestId, {
        project_id: requireString(payload, "project_id"),
        change_id: requireString(payload, "change_id"),
      });
    case "fs_list":
      return commandEnvelope("fs_list", requestId, {
        project_id: requireString(payload, "project_id"),
        path: requireString(payload, "path"),
      });
    case "fs_read":
      return commandEnvelope("fs_read", requestId, {
        project_id: requireString(payload, "project_id"),
        path: requireString(payload, "path"),
      });
    default:
      throw new Error(`Unknown command type: ${value.type}`);
  }
}

export function parseCoreEvent(value: unknown): CoreEvent {
  if (!isRecord(value)) throw new Error("Core event must be an object.");
  if (value.protocol_version !== PROTOCOL_VERSION) {
    throw new Error("Unsupported protocol version.");
  }

  const eventId = requireString(value, "event_id");
  const requestId = optionalString(value, "request_id");
  if (typeof value.type !== "string" || !isRecord(value.payload)) {
    throw new Error("Core event type and payload are required.");
  }
  const payload = value.payload;

  switch (value.type) {
    case "core_lifecycle": {
      const statusMessage = optionalString(payload, "status_message", true);
      return eventEnvelope(
        "core_lifecycle",
        eventId,
        {
          phase: parseCoreLifecyclePhase(payload.phase),
          ...(statusMessage === undefined
            ? {}
            : { status_message: statusMessage }),
        },
        requestId,
      );
    }
    case "provider_catalog_snapshot":
      return eventEnvelope(
        "provider_catalog_snapshot",
        eventId,
        {
          catalog_revision: requireNonNegativeInteger(
            payload,
            "catalog_revision",
          ),
          providers: parseProviderSummaries(payload.providers),
        },
        requestId,
      );
    case "ready":
      return eventEnvelope(
        "ready",
        eventId,
        { state: parseCoreStateSnapshot(payload.state) },
        requestId,
      );
    case "state_snapshot":
      return eventEnvelope(
        "state_snapshot",
        eventId,
        { state: parseCoreStateSnapshot(payload.state) },
        requestId,
      );
    case "run_state":
      return eventEnvelope(
        "run_state",
        eventId,
        {
          ...parseSessionScope(payload),
          is_running: requireBoolean(payload, "is_running"),
        },
        requestId,
      );
    case "timeline_entry_appended":
      return eventEnvelope(
        "timeline_entry_appended",
        eventId,
        {
          ...parseSessionScope(payload),
          entry: parseTimelineEntry(payload.entry),
        },
        requestId,
      );
    case "assistant_block_appended":
      return eventEnvelope(
        "assistant_block_appended",
        eventId,
        {
          ...parseSessionScope(payload),
          entry_id: requireString(payload, "entry_id"),
          block: parseAssistantBlock(payload.block),
        },
        requestId,
      );
    case "assistant_block_delta": {
      const blockType = payload.block_type;
      if (blockType !== "assistant_text" && blockType !== "reasoning") {
        throw new Error("Invalid assistant block delta type.");
      }
      return eventEnvelope(
        "assistant_block_delta",
        eventId,
        {
          ...parseSessionScope(payload),
          entry_id: requireString(payload, "entry_id"),
          block_id: requireString(payload, "block_id"),
          block_type: blockType,
          text_delta: requireString(payload, "text_delta", true),
        },
        requestId,
      );
    }
    case "timeline_entry_updated":
      return eventEnvelope(
        "timeline_entry_updated",
        eventId,
        {
          ...parseSessionScope(payload),
          entry: parseTimelineEntry(payload.entry),
        },
        requestId,
      );
    case "assistant_block_updated":
      return eventEnvelope(
        "assistant_block_updated",
        eventId,
        {
          ...parseSessionScope(payload),
          entry_id: requireString(payload, "entry_id"),
          block: parseAssistantBlock(payload.block),
        },
        requestId,
      );
    case "workspace_changed":
      return eventEnvelope(
        "workspace_changed",
        eventId,
        {
          ...parseSessionScope(payload),
          workspace_revision: requireNonNegativeInteger(
            payload,
            "workspace_revision",
          ),
          change: parseWorkspaceChangeSummary(payload.change),
        },
        requestId,
      );
    case "files_snapshot":
      return eventEnvelope(
        "files_snapshot",
        eventId,
        {
          project_id: requireString(payload, "project_id"),
          path: requireString(payload, "path"),
          workspace_revision: requireNonNegativeInteger(
            payload,
            "workspace_revision",
          ),
          files: requireArray(payload, "files").map(parseFileEntry),
        },
        requireEventRequestId(requestId, "files_snapshot"),
      );
    case "file_content":
      return eventEnvelope(
        "file_content",
        eventId,
        {
          project_id: requireString(payload, "project_id"),
          path: requireString(payload, "path"),
          workspace_revision: requireNonNegativeInteger(
            payload,
            "workspace_revision",
          ),
          content: requireString(payload, "content", true),
        },
        requireEventRequestId(requestId, "file_content"),
      );
    case "input_draft_saved":
      return eventEnvelope(
        "input_draft_saved",
        eventId,
        {
          project_id: requireString(payload, "project_id"),
          session_id: requireNullableString(payload, "session_id"),
          input_draft: requireString(payload, "input_draft", true),
        },
        requireEventRequestId(requestId, "input_draft_saved"),
      );
    case "workspace_export_snapshot":
      assertExactKeys(
        payload,
        ["project_id", "project_name", "workspace_revision", "files"],
        "workspace_export_snapshot payload",
      );
      return eventEnvelope(
        "workspace_export_snapshot",
        eventId,
        {
          project_id: requireString(payload, "project_id"),
          project_name: requireString(payload, "project_name"),
          workspace_revision: requireNonNegativeInteger(
            payload,
            "workspace_revision",
          ),
          files: parseWorkspaceTransferFiles(payload.files),
        },
        requireEventRequestId(requestId, "workspace_export_snapshot"),
      );
    case "workspace_change_snapshot":
      assertExactKeys(
        payload,
        ["project_id", "workspace_revision", "change"],
        "workspace_change_snapshot payload",
      );
      const workspaceRevision = requireNonNegativeInteger(
        payload,
        "workspace_revision",
      );
      const workspaceChange = parseWorkspaceChangeDetails(payload.change);
      if (
        workspaceChange.reverted_at_workspace_revision !== null &&
        workspaceChange.reverted_at_workspace_revision > workspaceRevision
      ) {
        throw new Error(
          "Workspace change revert revision cannot exceed workspace_revision.",
        );
      }
      return eventEnvelope(
        "workspace_change_snapshot",
        eventId,
        {
          project_id: requireString(payload, "project_id"),
          workspace_revision: workspaceRevision,
          change: workspaceChange,
        },
        requireEventRequestId(requestId, "workspace_change_snapshot"),
      );
    case "workspace_change_reverted":
      assertExactKeys(
        payload,
        [
          "project_id",
          "change_id",
          "path",
          "change_kind",
          "workspace_revision",
          "reverted_at_workspace_revision",
          "revert_outcome",
        ],
        "workspace_change_reverted payload",
      );
      const changeKind = parseWorkspaceChangeKind(payload.change_kind);
      const revertedWorkspaceRevision = requireNonNegativeInteger(
        payload,
        "workspace_revision",
      );
      const revertedAtWorkspaceRevision = requireNonNegativeInteger(
        payload,
        "reverted_at_workspace_revision",
      );
      const revertOutcome = parseWorkspaceChangeRevertOutcome(
        payload.revert_outcome,
      );
      if (
        revertedAtWorkspaceRevision > revertedWorkspaceRevision ||
        (revertOutcome === "applied" &&
          revertedAtWorkspaceRevision !== revertedWorkspaceRevision)
      ) {
        throw new Error(
          "Workspace change revert revisions do not match revert_outcome.",
        );
      }
      return eventEnvelope(
        "workspace_change_reverted",
        eventId,
        {
          project_id: requireString(payload, "project_id"),
          change_id: requireString(payload, "change_id"),
          path: requireString(payload, "path"),
          change_kind: changeKind,
          workspace_revision: revertedWorkspaceRevision,
          reverted_at_workspace_revision: revertedAtWorkspaceRevision,
          revert_outcome: revertOutcome,
        },
        requireEventRequestId(requestId, "workspace_change_reverted"),
      );
    case "error": {
      const projectId = optionalString(payload, "project_id");
      const sessionId = optionalString(payload, "session_id");
      const code = requireString(payload, "code");
      if (
        requiresErrorRequestId(code) &&
        requestId === undefined
      ) {
        throw new Error(`${code} events require request_id.`);
      }
      return eventEnvelope(
        "error",
        eventId,
        {
          code,
          message: requireString(payload, "message"),
          ...(projectId === undefined ? {} : { project_id: projectId }),
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
        },
        requestId,
      );
    }
    default:
      throw new Error(`Unknown core event type: ${value.type}`);
  }
}

function requiresErrorRequestId(code: string): boolean {
  return (
    code === "fs_list_failed" ||
    code === "fs_read_failed" ||
    code === "run_in_progress" ||
    code === "workspace_change_not_found" ||
    code === "workspace_change_conflict" ||
    code === "workspace_change_read_failed" ||
    code === "workspace_change_revert_failed"
  );
}

function requireEventRequestId(
  requestId: string | undefined,
  eventType:
    | "files_snapshot"
    | "file_content"
    | "input_draft_saved"
    | "workspace_export_snapshot"
    | "workspace_change_snapshot"
    | "workspace_change_reverted",
): string {
  if (requestId === undefined) {
    throw new Error(`${eventType} events require request_id.`);
  }
  return requestId;
}

export function parseWorkspaceTransferFiles(
  value: unknown,
): WorkspaceTransferFile[] {
  if (!Array.isArray(value)) {
    throw new Error("Workspace transfer files must be an array.");
  }
  assertJsonValue(value, "Workspace transfer files", new Set<object>());

  const paths = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Workspace transfer file ${index} must be an object.`);
    }
    assertExactKeys(
      candidate,
      ["path", "content"],
      `Workspace transfer file ${index}`,
    );
    const path = requireString(candidate, "path");
    if (paths.has(path)) {
      throw new Error(`Duplicate workspace transfer path: ${path}`);
    }
    paths.add(path);
    return {
      path,
      content: requireString(candidate, "content", true),
    };
  });
}

function commandEnvelope<T extends ViewerCommand["type"]>(
  type: T,
  requestId: string,
  payload: Extract<ViewerCommand, { type: T }>["payload"],
): Extract<ViewerCommand, { type: T }> {
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    type,
    payload,
  } as Extract<ViewerCommand, { type: T }>;
}

function eventEnvelope<T extends CoreEvent["type"]>(
  type: T,
  eventId: string,
  payload: Extract<CoreEvent, { type: T }>["payload"],
  requestId?: string,
): Extract<CoreEvent, { type: T }> {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: eventId,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    type,
    payload,
  } as Extract<CoreEvent, { type: T }>;
}

function parseCoreStateSnapshot(value: unknown): CoreStateSnapshot {
  if (!isRecord(value)) throw new Error("Core state must be an object.");
  const snapshot: CoreStateSnapshot = {
    state_revision: requireNonNegativeInteger(value, "state_revision"),
    catalog_revision: requireNonNegativeInteger(value, "catalog_revision"),
    workspace_revision: requireNonNegativeInteger(
      value,
      "workspace_revision",
    ),
    projects: requireArray(value, "projects").map(parseProjectSummary),
    sessions: requireArray(value, "sessions").map(parseSessionSummary),
    providers: requireArray(value, "providers").map(parseProviderSummary),
    active_model: parseModelSelection(value.active_model),
    active_project_id: requireString(value, "active_project_id"),
    active_session_id: requireNullableString(value, "active_session_id"),
    input_draft: requireString(value, "input_draft", true),
    timeline: parseTimeline(value.timeline),
    files: requireArray(value, "files").map(parseFileEntry),
    is_running: requireBoolean(value, "is_running"),
  };
  assertCoreStateInvariants(snapshot);
  return snapshot;
}

function assertCoreStateInvariants(snapshot: CoreStateSnapshot): void {
  const projects = new Set<string>();
  for (const project of snapshot.projects) {
    if (projects.has(project.project_id)) {
      throw new Error(`Duplicate project_id: ${project.project_id}`);
    }
    projects.add(project.project_id);
  }
  const sessions = new Map<string, SessionSummary>();
  for (const session of snapshot.sessions) {
    if (sessions.has(session.session_id)) {
      throw new Error(`Duplicate session_id: ${session.session_id}`);
    }
    if (!projects.has(session.project_id)) {
      throw new Error("Session references an unknown project_id.");
    }
    sessions.set(session.session_id, session);
  }
  if (!projects.has(snapshot.active_project_id)) {
    throw new Error("active_project_id does not exist.");
  }
  const providers = new Map(
    snapshot.providers.map((provider) => [provider.provider_id, provider]),
  );
  if (providers.size !== snapshot.providers.length) {
    throw new Error("Duplicate provider_id.");
  }
  const activeProvider = providers.get(snapshot.active_model.provider_id);
  if (!activeProvider) {
    throw new Error("active_model references an unknown provider_id.");
  }
  if (
    !activeProvider.models.some(
      (model) => model.model_id === snapshot.active_model.model_id,
    )
  ) {
    throw new Error("active_model references an unknown model_id.");
  }
  if (snapshot.active_session_id === null) {
    if (snapshot.timeline.length > 0) {
      throw new Error("Virtual new chat cannot contain timeline entries.");
    }
    if (snapshot.is_running) {
      throw new Error("Virtual new chat cannot have an active run.");
    }
    return;
  }

  const activeSession = sessions.get(snapshot.active_session_id);
  if (!activeSession) throw new Error("active_session_id does not exist.");
  if (activeSession.project_id !== snapshot.active_project_id) {
    throw new Error("Active session does not belong to active project.");
  }
  const userPromptCount = snapshot.timeline.filter(
    (entry) => entry.type === "user_message",
  ).length;
  if (activeSession.message_count !== userPromptCount) {
    throw new Error(
      "Active session message_count must equal its user prompt count.",
    );
  }
}

function parseProjectSummary(value: unknown): ProjectSummary {
  if (!isRecord(value)) throw new Error("Project summary must be an object.");
  return {
    project_id: requireString(value, "project_id"),
    name: requireString(value, "name"),
    created_at: requireString(value, "created_at"),
    updated_at: requireString(value, "updated_at"),
  };
}

function parseSessionSummary(value: unknown): SessionSummary {
  if (!isRecord(value)) throw new Error("Session summary must be an object.");
  return {
    session_id: requireString(value, "session_id"),
    project_id: requireString(value, "project_id"),
    title: requireString(value, "title"),
    created_at: requireString(value, "created_at"),
    updated_at: requireString(value, "updated_at"),
    message_count: requireNonNegativeInteger(value, "message_count"),
  };
}

export function parseModelSelection(value: unknown): ModelSelection {
  if (!isRecord(value)) throw new Error("Model selection must be an object.");
  return {
    provider_id: requireString(value, "provider_id"),
    model_id: requireString(value, "model_id"),
  };
}

function parseModelSummary(value: unknown): ModelSummary {
  const selection = parseModelSelection(value);
  if (!isRecord(value)) throw new Error("Model summary must be an object.");
  const availability = value.availability;
  if (availability !== "ready" && availability !== "unavailable") {
    throw new Error("Invalid model availability.");
  }
  const statusMessage = optionalString(value, "status_message", true);
  return {
    ...selection,
    display_name: requireString(value, "display_name"),
    availability,
    ...(statusMessage === undefined ? {} : { status_message: statusMessage }),
  };
}

function parseProviderSummary(value: unknown): ProviderSummary {
  if (!isRecord(value)) throw new Error("Provider summary must be an object.");
  const kind = value.kind;
  const availability = value.availability;
  if (kind !== "mock" && kind !== "openai_compatible") {
    throw new Error("Invalid provider kind.");
  }
  if (
    availability !== "loading" &&
    availability !== "ready" &&
    availability !== "unavailable"
  ) {
    throw new Error("Invalid provider availability.");
  }
  const providerId = requireString(value, "provider_id");
  const statusMessage = optionalString(value, "status_message", true);
  const models = requireArray(value, "models").map(parseModelSummary);
  const modelIds = new Set<string>();
  for (const model of models) {
    if (model.provider_id !== providerId) {
      throw new Error("Model provider_id does not match its provider.");
    }
    if (modelIds.has(model.model_id)) throw new Error("Duplicate model_id.");
    modelIds.add(model.model_id);
  }
  return {
    provider_id: providerId,
    display_name: requireString(value, "display_name"),
    kind,
    availability,
    ...(statusMessage === undefined ? {} : { status_message: statusMessage }),
    models,
  };
}

function parseProviderSummaries(value: unknown): ProviderSummary[] {
  if (!Array.isArray(value)) throw new Error("providers must be an array.");
  const providers = value.map(parseProviderSummary);
  const providerIds = new Set<string>();
  for (const provider of providers) {
    if (providerIds.has(provider.provider_id)) {
      throw new Error("Duplicate provider_id.");
    }
    providerIds.add(provider.provider_id);
  }
  return providers;
}

function parseCoreLifecyclePhase(value: unknown): CoreLifecyclePhase {
  if (
    value !== "electing" &&
    value !== "waiting_for_writer" &&
    value !== "initializing_workspace" &&
    value !== "ready" &&
    value !== "failed"
  ) {
    throw new Error("Invalid core lifecycle phase.");
  }
  return value;
}

function parseSessionScope(value: Record<string, unknown>): SessionScope {
  return {
    project_id: requireString(value, "project_id"),
    session_id: requireString(value, "session_id"),
  };
}

export function parseTimeline(value: unknown): TimelineEntry[] {
  if (!Array.isArray(value)) throw new Error("Timeline must be an array.");
  const timeline = value.map(parseTimelineEntry);
  assertTimelineInvariants(timeline);
  return timeline;
}

export function parseTimelineEntry(value: unknown): TimelineEntry {
  if (!isRecord(value)) throw new Error("Timeline entry must be an object.");
  const base = {
    entry_id: requireString(value, "entry_id"),
    run_id: requireString(value, "run_id"),
    created_at: requireIsoTimestamp(value, "created_at"),
  };
  switch (value.type) {
    case "user_message":
      return {
        type: "user_message",
        ...base,
        content: requireString(value, "content", true),
      };
    case "assistant_message": {
      const status = parseAssistantMessageStatus(value.status);
      const stopReason = parseAssistantStopReason(value.stop_reason);
      assertAssistantCompletion(status, stopReason);
      const responseModel = optionalString(value, "response_model");
      const responseId = optionalString(value, "response_id");
      const errorMessage = optionalString(value, "error_message", true);
      const blocks = requireArray(value, "blocks").map(parseAssistantBlock);
      assertUniqueBlockIds(blocks);
      return {
        type: "assistant_message",
        ...base,
        status,
        api: requireString(value, "api"),
        provider: requireString(value, "provider"),
        model: requireString(value, "model"),
        ...(responseModel === undefined
          ? {}
          : { response_model: responseModel }),
        ...(responseId === undefined ? {} : { response_id: responseId }),
        usage: parseAssistantUsage(value.usage),
        ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
        ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
        blocks,
      };
    }
    case "tool_result": {
      const toolCallId = requireString(value, "tool_call_id");
      const summary = optionalString(value, "summary", true);
      const fileChange =
        value.file_change === undefined
          ? undefined
          : parseWorkspaceChangeSummary(value.file_change);
      if (fileChange && fileChange.tool_call_id !== toolCallId) {
        throw new Error("Tool result file_change must match tool_call_id.");
      }
      return {
        type: "tool_result",
        ...base,
        tool_call_block_id: requireString(value, "tool_call_block_id"),
        tool_call_id: toolCallId,
        tool_name: requireString(value, "tool_name"),
        content: requireString(value, "content", true),
        is_error: requireBoolean(value, "is_error"),
        ...(summary === undefined ? {} : { summary }),
        ...(fileChange === undefined ? {} : { file_change: fileChange }),
      };
    }
    default:
      throw new Error("Invalid timeline entry type.");
  }
}

export function parseAssistantBlock(value: unknown): AssistantBlock {
  if (!isRecord(value)) throw new Error("Assistant block must be an object.");
  const blockId = requireString(value, "block_id");
  switch (value.type) {
    case "assistant_text": {
      const textSignature = optionalString(value, "text_signature", true);
      return {
        type: "assistant_text",
        block_id: blockId,
        text: requireString(value, "text", true),
        ...(textSignature === undefined
          ? {}
          : { text_signature: textSignature }),
      };
    }
    case "reasoning": {
      const thinkingSignature = optionalString(
        value,
        "thinking_signature",
        true,
      );
      const redacted = optionalBoolean(value, "redacted");
      return {
        type: "reasoning",
        block_id: blockId,
        text: requireString(value, "text", true),
        ...(thinkingSignature === undefined
          ? {}
          : { thinking_signature: thinkingSignature }),
        ...(redacted === undefined ? {} : { redacted }),
      };
    }
    case "tool_call": {
      const thoughtSignature = optionalString(
        value,
        "thought_signature",
        true,
      );
      const label = optionalString(value, "label", true);
      return {
        type: "tool_call",
        block_id: blockId,
        tool_call_id: requireString(value, "tool_call_id"),
        tool_name: requireString(value, "tool_name"),
        arguments: cloneJsonObject(value.arguments, "Tool arguments"),
        ...(thoughtSignature === undefined
          ? {}
          : { thought_signature: thoughtSignature }),
        ...(label === undefined ? {} : { label }),
      };
    }
    default:
      throw new Error("Invalid assistant block type.");
  }
}

export function assertTimelineInvariants(timeline: TimelineEntry[]): void {
  const entryIds = new Set<string>();
  const blockIds = new Set<string>();
  const seenRuns = new Set<string>();
  const resolvedToolCalls = new Set<string>();
  let pendingToolCalls: Map<
    string,
    {
      entry_index: number;
      run_id: string;
      tool_call_id: string;
      tool_name: string;
    }
  > | null = null;
  let currentRunId: string | undefined;

  for (const [entryIndex, entry] of timeline.entries()) {
    assertIsoTimestamp(entry.created_at, "Timeline entry created_at");
    if (entryIds.has(entry.entry_id)) {
      throw new Error(`Duplicate timeline entry_id: ${entry.entry_id}`);
    }
    entryIds.add(entry.entry_id);

    if (pendingToolCalls && entry.type !== "tool_result") {
      throw new Error(
        "Assistant tool calls must be followed immediately by their tool results.",
      );
    }

    if (entry.run_id !== currentRunId) {
      if (seenRuns.has(entry.run_id)) {
        throw new Error(`Timeline run is not contiguous: ${entry.run_id}`);
      }
      if (entry.type !== "user_message") {
        throw new Error("Every timeline run must start with a user_message.");
      }
      seenRuns.add(entry.run_id);
      currentRunId = entry.run_id;
    } else if (entry.type === "user_message") {
      throw new Error("A timeline run must contain exactly one user_message.");
    }

    if (entry.type === "assistant_message") {
      const rawToolCallIds = new Set<string>();
      const entryToolCalls = new Map<
        string,
        {
          entry_index: number;
          run_id: string;
          tool_call_id: string;
          tool_name: string;
        }
      >();
      for (const block of entry.blocks) {
        if (blockIds.has(block.block_id)) {
          throw new Error(`Duplicate assistant block_id: ${block.block_id}`);
        }
        blockIds.add(block.block_id);
        if (block.type === "tool_call") {
          if (rawToolCallIds.has(block.tool_call_id)) {
            throw new Error(
              `Duplicate tool_call_id in assistant message: ${block.tool_call_id}`,
            );
          }
          rawToolCallIds.add(block.tool_call_id);
          entryToolCalls.set(block.block_id, {
            entry_index: entryIndex,
            run_id: entry.run_id,
            tool_call_id: block.tool_call_id,
            tool_name: block.tool_name,
          });
        }
      }
      pendingToolCalls = entryToolCalls.size === 0 ? null : entryToolCalls;
      continue;
    }
    if (entry.type !== "tool_result") continue;

    if (resolvedToolCalls.has(entry.tool_call_block_id)) {
      throw new Error("A tool_call block can have at most one tool result.");
    }
    const toolCall = pendingToolCalls?.get(entry.tool_call_block_id);
    if (!toolCall || toolCall.entry_index >= entryIndex) {
      throw new Error(
        "Tool result must reference the active assistant tool-call group.",
      );
    }
    if (toolCall.run_id !== entry.run_id) {
      throw new Error("Tool result must belong to the tool call's run.");
    }
    if (
      toolCall.tool_call_id !== entry.tool_call_id ||
      toolCall.tool_name !== entry.tool_name
    ) {
      throw new Error("Tool result identity must match its tool_call block.");
    }
    resolvedToolCalls.add(entry.tool_call_block_id);
    pendingToolCalls?.delete(entry.tool_call_block_id);
    if (pendingToolCalls?.size === 0) pendingToolCalls = null;
  }
}

function assertUniqueBlockIds(blocks: AssistantBlock[]): void {
  const blockIds = new Set<string>();
  for (const block of blocks) {
    if (blockIds.has(block.block_id)) {
      throw new Error(`Duplicate assistant block_id: ${block.block_id}`);
    }
    blockIds.add(block.block_id);
  }
}

function parseAssistantUsage(value: unknown): AssistantUsage {
  if (!isRecord(value)) throw new Error("Assistant usage must be an object.");
  const cost = value.cost;
  if (!isRecord(cost)) throw new Error("Assistant usage cost must be an object.");
  return {
    input: requireNonNegativeNumber(value, "input"),
    output: requireNonNegativeNumber(value, "output"),
    cache_read: requireNonNegativeNumber(value, "cache_read"),
    cache_write: requireNonNegativeNumber(value, "cache_write"),
    total_tokens: requireNonNegativeNumber(value, "total_tokens"),
    cost: {
      input: requireNonNegativeNumber(cost, "input"),
      output: requireNonNegativeNumber(cost, "output"),
      cache_read: requireNonNegativeNumber(cost, "cache_read"),
      cache_write: requireNonNegativeNumber(cost, "cache_write"),
      total: requireNonNegativeNumber(cost, "total"),
    },
  };
}

function parseAssistantMessageStatus(value: unknown): AssistantMessageStatus {
  if (
    value !== "streaming" &&
    value !== "complete" &&
    value !== "aborted" &&
    value !== "error"
  ) {
    throw new Error("Invalid assistant message status.");
  }
  return value;
}

function parseAssistantStopReason(
  value: unknown,
): AssistantStopReason | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "stop" &&
    value !== "length" &&
    value !== "tool_use" &&
    value !== "error" &&
    value !== "aborted"
  ) {
    throw new Error("Invalid assistant stop_reason.");
  }
  return value;
}

function assertAssistantCompletion(
  status: AssistantMessageStatus,
  stopReason: AssistantStopReason | undefined,
): void {
  if (status === "streaming" && stopReason !== undefined) {
    throw new Error("Streaming assistant messages cannot have stop_reason.");
  }
  if (
    status === "complete" &&
    stopReason !== "stop" &&
    stopReason !== "length" &&
    stopReason !== "tool_use"
  ) {
    throw new Error(
      "Complete assistant messages require a completion stop_reason.",
    );
  }
  if (status === "aborted" && stopReason !== "aborted") {
    throw new Error("Aborted assistant messages require aborted stop_reason.");
  }
  if (status === "error" && stopReason !== "error") {
    throw new Error("Errored assistant messages require error stop_reason.");
  }
}

function parseFileEntry(value: unknown): FileEntry {
  if (!isRecord(value)) throw new Error("File entry must be an object.");
  if (value.kind !== "file" && value.kind !== "directory") {
    throw new Error("Invalid file entry kind.");
  }
  return {
    name: requireString(value, "name"),
    path: requireString(value, "path"),
    kind: value.kind,
    size: requireNonNegativeNumber(value, "size"),
  };
}

export function parseWorkspaceChangeSummary(
  value: unknown,
): WorkspaceChangeSummary {
  if (!isRecord(value)) {
    throw new Error("Workspace change summary must be an object.");
  }
  const changeKind = parseWorkspaceChangeKind(value.change_kind);
  return {
    change_id: requireString(value, "change_id"),
    tool_call_id: requireString(value, "tool_call_id"),
    path: requireString(value, "path"),
    change_kind: changeKind,
    additions: requireNonNegativeInteger(value, "additions"),
    deletions: requireNonNegativeInteger(value, "deletions"),
    byte_size: requireNonNegativeInteger(value, "byte_size"),
  };
}

function parseWorkspaceChangeKind(
  value: unknown,
): WorkspaceChangeSummary["change_kind"] {
  if (value !== "created" && value !== "updated") {
    throw new Error("Invalid workspace change kind.");
  }
  return value;
}

function parseWorkspaceChangeRevertOutcome(
  value: unknown,
): "applied" | "already_reverted" {
  if (value !== "applied" && value !== "already_reverted") {
    throw new Error("Invalid workspace change revert outcome.");
  }
  return value;
}

export function parseWorkspaceChangeDetails(
  value: unknown,
): WorkspaceChangeDetails {
  if (!isRecord(value)) {
    throw new Error("Workspace change details must be an object.");
  }
  assertExactKeys(
    value,
    [
      "change_id",
      "tool_call_id",
      "path",
      "change_kind",
      "additions",
      "deletions",
      "byte_size",
      "before_content",
      "after_content",
      "current_content",
      "reverted_at_workspace_revision",
      "revert_status",
    ],
    "Workspace change details",
  );
  const summary = parseWorkspaceChangeSummary(value);
  const revertStatus = value.revert_status;
  if (
    revertStatus !== "available" &&
    revertStatus !== "already_reverted" &&
    revertStatus !== "conflict"
  ) {
    throw new Error("Invalid workspace change revert status.");
  }
  const beforeContent = requireNullableString(value, "before_content", true);
  if (
    (summary.change_kind === "created" && beforeContent !== null) ||
    (summary.change_kind === "updated" && beforeContent === null)
  ) {
    throw new Error(
      "Workspace change before_content does not match change_kind.",
    );
  }
  const afterContent = requireString(value, "after_content", true);
  const currentContent = requireNullableString(
    value,
    "current_content",
    true,
  );
  const revertedAtWorkspaceRevision = requireNullableNonNegativeInteger(
    value,
    "reverted_at_workspace_revision",
  );
  if (
    (revertStatus === "already_reverted") !==
    (revertedAtWorkspaceRevision !== null)
  ) {
    throw new Error(
      "Workspace change revert status does not match its revert revision.",
    );
  }
  if (
    revertStatus === "available" &&
    currentContent !== afterContent
  ) {
    throw new Error(
      "Available workspace change current_content must match after_content.",
    );
  }
  return {
    ...summary,
    before_content: beforeContent,
    after_content: afterContent,
    current_content: currentContent,
    reverted_at_workspace_revision: revertedAtWorkspaceRevision,
    revert_status: revertStatus,
  };
}

function requireArray(
  value: Record<string, unknown>,
  field: string,
): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) throw new Error(`${field} must be an array.`);
  return candidate;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length === expected.length &&
    expected.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    return;
  }
  throw new Error(
    `${label} must contain exactly: ${expected.join(", ")}.`,
  );
}

function requireBoolean(
  value: Record<string, unknown>,
  field: string,
): boolean {
  const candidate = value[field];
  if (typeof candidate !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return candidate;
}

function optionalBoolean(
  value: Record<string, unknown>,
  field: string,
): boolean | undefined {
  if (value[field] === undefined) return undefined;
  return requireBoolean(value, field);
}

function requireNonNegativeInteger(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = requireNonNegativeNumber(value, field);
  if (!Number.isSafeInteger(candidate)) {
    throw new Error(`${field} must be a safe integer.`);
  }
  return candidate;
}

function requireNullableNonNegativeInteger(
  value: Record<string, unknown>,
  field: string,
): number | null {
  if (value[field] === null) return null;
  return requireNonNegativeInteger(value, field);
}

function requireNonNegativeNumber(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
  allowEmpty = false,
): string | undefined {
  if (value[field] === undefined) return undefined;
  return requireString(value, field, allowEmpty);
}

function requireNullableString(
  value: Record<string, unknown>,
  field: string,
  allowEmpty = false,
): string | null {
  const candidate = value[field];
  if (candidate === null) return null;
  if (
    typeof candidate === "string" &&
    (allowEmpty || candidate.length > 0)
  ) {
    return candidate;
  }
  throw new Error(
    allowEmpty
      ? `${field} must be null or a string.`
      : `${field} must be null or a non-empty string.`,
  );
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  allowEmpty = false,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    (!allowEmpty && candidate.length === 0)
  ) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return candidate;
}

function requireIsoTimestamp(
  value: Record<string, unknown>,
  field: string,
): string {
  const candidate = requireString(value, field);
  assertIsoTimestamp(candidate, field);
  return candidate;
}

function assertIsoTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a valid canonical ISO timestamp.`);
  }
  try {
    if (new Date(parsed).toISOString() !== value) {
      throw new Error(`${label} must be a valid canonical ISO timestamp.`);
    }
  } catch {
    throw new Error(`${label} must be a valid canonical ISO timestamp.`);
  }
}

function cloneJsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertJsonValue(value, label, new Set<object>());
  return structuredClone(value);
}

function assertJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must contain only JSON values.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} must contain only JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} cannot contain cycles.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only JSON values.`);
    }
    for (const item of Object.values(value)) {
      assertJsonValue(item, label, ancestors);
    }
  }
  ancestors.delete(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
