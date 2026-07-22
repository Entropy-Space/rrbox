export const PROTOCOL_VERSION = 6 as const;

export type MessageRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  status: "streaming" | "complete" | "aborted" | "error";
};

export type FileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
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

export type ToolActivity = {
  activity_id: string;
  tool_call_id: string;
  message_id: string;
  tool_name: string;
  label: string;
  status: "running" | "complete" | "error";
  summary?: string;
  file_change?: WorkspaceChangeSummary;
};

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
  messages: ChatMessage[];
  activities: ToolActivity[];
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
  | EventEnvelope<"message_added", SessionScope & { message: ChatMessage }>
  | EventEnvelope<
      "message_delta",
      SessionScope & { message_id: string; text_delta: string }
    >
  | EventEnvelope<
      "message_finished",
      SessionScope & {
        message_id: string;
        status: "complete" | "aborted" | "error";
        error_message?: string;
      }
    >
  | EventEnvelope<"tool_activity", SessionScope & { activity: ToolActivity }>
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
    case "message_added":
      return eventEnvelope(
        "message_added",
        eventId,
        {
          ...parseSessionScope(payload),
          message: parseChatMessage(payload.message),
        },
        requestId,
      );
    case "message_delta":
      return eventEnvelope(
        "message_delta",
        eventId,
        {
          ...parseSessionScope(payload),
          message_id: requireString(payload, "message_id"),
          text_delta: requireString(payload, "text_delta", true),
        },
        requestId,
      );
    case "message_finished": {
      const status = parseFinishedStatus(payload.status);
      const errorMessage = optionalString(payload, "error_message", true);
      return eventEnvelope(
        "message_finished",
        eventId,
        {
          ...parseSessionScope(payload),
          message_id: requireString(payload, "message_id"),
          status,
          ...(errorMessage === undefined
            ? {}
            : { error_message: errorMessage }),
        },
        requestId,
      );
    }
    case "tool_activity":
      return eventEnvelope(
        "tool_activity",
        eventId,
        {
          ...parseSessionScope(payload),
          activity: parseToolActivity(payload.activity),
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
    case "error": {
      const projectId = optionalString(payload, "project_id");
      const sessionId = optionalString(payload, "session_id");
      const code = requireString(payload, "code");
      if (
        (code === "fs_list_failed" || code === "fs_read_failed") &&
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

function requireEventRequestId(
  requestId: string | undefined,
  eventType: "files_snapshot" | "file_content" | "input_draft_saved",
): string {
  if (requestId === undefined) {
    throw new Error(`${eventType} events require request_id.`);
  }
  return requestId;
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
    messages: requireArray(value, "messages").map(parseChatMessage),
    activities: requireArray(value, "activities").map(parseToolActivity),
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
  const activityIds = new Set<string>();
  for (const activity of snapshot.activities) {
    if (activityIds.has(activity.activity_id)) {
      throw new Error(`Duplicate activity_id: ${activity.activity_id}`);
    }
    activityIds.add(activity.activity_id);
  }
  if (snapshot.active_session_id === null) {
    if (snapshot.messages.length > 0 || snapshot.activities.length > 0) {
      throw new Error(
        "Virtual new chat cannot contain messages or tool activities.",
      );
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

function parseChatMessage(value: unknown): ChatMessage {
  if (!isRecord(value)) throw new Error("Chat message must be an object.");
  const role = value.role;
  const status = value.status;
  if (role !== "user" && role !== "assistant") {
    throw new Error("Invalid chat message role.");
  }
  if (
    status !== "streaming" &&
    status !== "complete" &&
    status !== "aborted" &&
    status !== "error"
  ) {
    throw new Error("Invalid chat message status.");
  }
  return {
    id: requireString(value, "id"),
    role,
    content: requireString(value, "content", true),
    created_at: requireString(value, "created_at"),
    status,
  };
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

function parseToolActivity(value: unknown): ToolActivity {
  if (!isRecord(value)) throw new Error("Tool activity must be an object.");
  const status = value.status;
  if (status !== "running" && status !== "complete" && status !== "error") {
    throw new Error("Invalid tool activity status.");
  }
  const summary = optionalString(value, "summary", true);
  const toolCallId = requireString(value, "tool_call_id");
  const fileChange =
    value.file_change === undefined
      ? undefined
      : parseWorkspaceChangeSummary(value.file_change);
  if (fileChange && fileChange.tool_call_id !== toolCallId) {
    throw new Error("Tool activity file_change must match tool_call_id.");
  }
  return {
    activity_id: requireString(value, "activity_id"),
    tool_call_id: toolCallId,
    message_id: requireString(value, "message_id"),
    tool_name: requireString(value, "tool_name"),
    label: requireString(value, "label"),
    status,
    ...(summary === undefined ? {} : { summary }),
    ...(fileChange === undefined ? {} : { file_change: fileChange }),
  };
}

function parseWorkspaceChangeSummary(
  value: unknown,
): WorkspaceChangeSummary {
  if (!isRecord(value)) {
    throw new Error("Workspace change summary must be an object.");
  }
  const changeKind = value.change_kind;
  if (changeKind !== "created" && changeKind !== "updated") {
    throw new Error("Invalid workspace change kind.");
  }
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

function parseFinishedStatus(
  value: unknown,
): "complete" | "aborted" | "error" {
  if (value !== "complete" && value !== "aborted" && value !== "error") {
    throw new Error("Invalid finished message status.");
  }
  return value;
}

function requireArray(
  value: Record<string, unknown>,
  field: string,
): unknown[] {
  const candidate = value[field];
  if (!Array.isArray(candidate)) throw new Error(`${field} must be an array.`);
  return candidate;
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

function requireNonNegativeInteger(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = requireNonNegativeNumber(value, field);
  if (!Number.isInteger(candidate)) {
    throw new Error(`${field} must be an integer.`);
  }
  return candidate;
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
): string | null {
  const candidate = value[field];
  if (candidate === null) return null;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  throw new Error(`${field} must be null or a non-empty string.`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
