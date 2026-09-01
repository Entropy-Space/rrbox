import type {
  AssistantBlock,
  AssistantMessageEntry,
  ModelSelection,
  ReasoningEffort,
  TimelineEntry,
  ToolCallBlock,
  WorkspaceChangeSummary,
} from "@researchbox/protocol";
import {
  assertTimelineInvariants,
  emptyAssistantUsage,
  parseReasoningEffort,
  parseTimeline,
} from "@researchbox/protocol";
import {
  assertSessionHistoryInvariants,
  createSessionHistory,
  parseSessionHistory,
  type SessionHistory,
} from "./history.ts";

export const PROJECT_STORE_SCHEMA_VERSION = 4 as const;
export const SESSION_DOCUMENT_FORMAT_VERSION = 5 as const;
export const RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION = 6 as const;

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  provider_id: "researchbox",
  model_id: "researchbox-mock",
};

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "default";

const LEGACY_PROJECT_STORE_SCHEMA_VERSION = 1 as const;
const DRAFT_PROJECT_STORE_SCHEMA_VERSION = 2 as const;
const MODEL_SELECTION_PROJECT_STORE_SCHEMA_VERSION = 3 as const;
const LEGACY_SESSION_DOCUMENT_FORMAT_VERSION = 1 as const;
const TRANSCRIPT_SESSION_DOCUMENT_FORMAT_VERSION = 2 as const;
const TIMELINE_SESSION_DOCUMENT_FORMAT_VERSION = 3 as const;
const LINEAR_SESSION_DOCUMENT_FORMAT_VERSION = 4 as const;

export type ProjectRecord = {
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  last_session_id: string | null;
  new_chat_draft: string;
  new_chat_model: ModelSelection;
  new_chat_reasoning_effort: ReasoningEffort;
};

export type SessionRecord = {
  session_id: string;
  project_id: string;
  title: string;
  title_is_custom: boolean;
  created_at: string;
  updated_at: string;
  selected_model: ModelSelection;
  reasoning_effort: ReasoningEffort;
};

export type LegacySessionDocument = {
  format_version: typeof SESSION_DOCUMENT_FORMAT_VERSION;
  session_id: string;
  project_id: string;
  input_draft: string;
  timeline: TimelineEntry[];
  history: SessionHistory;
};

/** Host-owned client/index state for a canonical external runtime session. */
export type RuntimeSessionDocument = {
  format_version: typeof RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION;
  session_id: string;
  project_id: string;
  input_draft: string;
  runtime_id: string;
  /** Cached read-model count; the runtime event log remains authoritative. */
  message_count: number;
  /**
   * Durable copy-on-write intent. The runtime clears this only after the
   * source timeline has been materialized in its own canonical persistence.
   */
  migration_source_session_id?: string;
};

export type SessionDocument =
  | LegacySessionDocument
  | RuntimeSessionDocument;

export type ProjectStoreState = {
  schema_version: typeof PROJECT_STORE_SCHEMA_VERSION;
  state_revision: number;
  active_project_id: string;
  active_session_id: string | null;
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  documents: SessionDocument[];
};

export type ProjectStoreParseResult = {
  state: ProjectStoreState;
  was_migrated: boolean;
};

export function isLegacySessionDocument(
  document: SessionDocument,
): document is LegacySessionDocument {
  return document.format_version === SESSION_DOCUMENT_FORMAT_VERSION;
}

export function isRuntimeSessionDocument(
  document: SessionDocument,
): document is RuntimeSessionDocument {
  return document.format_version === RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION;
}

export function sessionDocumentMessageCount(
  document: SessionDocument,
): number {
  return isLegacySessionDocument(document)
    ? document.timeline.filter((entry) => entry.type === "user_message").length
    : document.message_count;
}

export function cloneProjectStoreState(
  state: ProjectStoreState,
): ProjectStoreState {
  return structuredClone(state);
}

export function parseProjectStoreState(value: unknown): ProjectStoreState {
  return parseProjectStoreStateWithMigration(value).state;
}

export function parseProjectStoreStateWithMigration(
  value: unknown,
): ProjectStoreParseResult {
  if (!isRecord(value)) throw new Error("Project store state must be an object.");
  const schemaVersion = value.schema_version;
  if (
    schemaVersion !== PROJECT_STORE_SCHEMA_VERSION &&
    schemaVersion !== MODEL_SELECTION_PROJECT_STORE_SCHEMA_VERSION &&
    schemaVersion !== DRAFT_PROJECT_STORE_SCHEMA_VERSION &&
    schemaVersion !== LEGACY_PROJECT_STORE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported project store schema version.");
  }

  const legacy = schemaVersion === LEGACY_PROJECT_STORE_SCHEMA_VERSION;
  const hasModelSelection =
    schemaVersion === PROJECT_STORE_SCHEMA_VERSION ||
    schemaVersion === MODEL_SELECTION_PROJECT_STORE_SCHEMA_VERSION;
  const hasReasoningEffort = schemaVersion === PROJECT_STORE_SCHEMA_VERSION;
  const storedDocuments = requireArray(value, "documents");
  const emptyLegacyDocuments = legacy
    ? findEmptyLegacyDocuments(storedDocuments)
    : new Set<string>();
  let migratedDocument = false;
  const state: ProjectStoreState = {
    schema_version: PROJECT_STORE_SCHEMA_VERSION,
    state_revision: requireNonNegativeInteger(value, "state_revision"),
    active_project_id: requireString(value, "active_project_id"),
    active_session_id: legacy
      ? requireString(value, "active_session_id")
      : requireNullableString(value, "active_session_id"),
    projects: requireArray(value, "projects").map((project) =>
      parseProjectRecord(
        project,
        legacy,
        hasModelSelection,
        hasReasoningEffort,
      ),
    ),
    sessions: requireArray(value, "sessions").map((session) =>
      parseSessionRecord(session, hasModelSelection, hasReasoningEffort),
    ),
    documents: storedDocuments.map((document) => {
      const parsed = parseSessionDocument(document, legacy);
      migratedDocument ||= parsed.was_migrated;
      return parsed.document;
    }),
  };

  if (legacy) removeLegacyPlaceholderSessions(state, emptyLegacyDocuments);
  assertProjectStoreInvariants(state);
  return {
    state,
    was_migrated:
      schemaVersion !== PROJECT_STORE_SCHEMA_VERSION || migratedDocument,
  };
}

export function assertProjectStoreInvariants(state: ProjectStoreState): void {
  if (state.projects.length === 0) {
    throw new Error("Project store must contain at least one project.");
  }

  const projects = uniqueMap(
    state.projects,
    (project) => project.project_id,
    "project",
  );
  const sessions = uniqueMap(
    state.sessions,
    (session) => session.session_id,
    "session",
  );
  const documents = uniqueMap(
    state.documents,
    (document) => document.session_id,
    "session document",
  );

  const activeProject = projects.get(state.active_project_id);
  if (!activeProject) throw new Error("Active project does not exist.");
  if (state.active_session_id !== null) {
    const activeSession = sessions.get(state.active_session_id);
    if (!activeSession) throw new Error("Active session does not exist.");
    if (activeSession.project_id !== activeProject.project_id) {
      throw new Error("Active session does not belong to the active project.");
    }
  }

  for (const project of state.projects) {
    if (project.last_session_id === null) continue;
    const lastSession = sessions.get(project.last_session_id);
    if (!lastSession || lastSession.project_id !== project.project_id) {
      throw new Error("Project last_session_id is invalid.");
    }
  }

  for (const session of state.sessions) {
    if (!projects.has(session.project_id)) {
      throw new Error("Session references an unknown project.");
    }
    const document = documents.get(session.session_id);
    if (!document) throw new Error("Session document is missing.");
    if (document.project_id !== session.project_id) {
      throw new Error("Session document project_id does not match its session.");
    }
    if (isUnsubmittedNewChat(session, document)) {
      throw new Error("Unsubmitted new chats must not be persisted as sessions.");
    }
    if (isLegacySessionDocument(document)) {
      assertTimelineInvariants(document.timeline);
      assertSessionHistoryInvariants(document.history);
    } else if (
      document.runtime_id.length === 0 ||
      !Number.isSafeInteger(document.message_count) ||
      document.message_count < 0
    ) {
      throw new Error("Runtime session document metadata is invalid.");
    } else if (document.migration_source_session_id !== undefined) {
      const source = documents.get(document.migration_source_session_id);
      if (
        source === undefined ||
        !isLegacySessionDocument(source) ||
        source.session_id === document.session_id ||
        source.project_id !== document.project_id
      ) {
        throw new Error(
          "Runtime session migration source must be a legacy session in the same project.",
        );
      }
    }
  }

  if (documents.size !== sessions.size) {
    throw new Error("Project store contains an orphan session document.");
  }
}

function parseProjectRecord(
  value: unknown,
  legacy: boolean,
  hasModelSelection: boolean,
  hasReasoningEffort: boolean,
): ProjectRecord {
  if (!isRecord(value)) throw new Error("Project record must be an object.");
  return {
    project_id: requireString(value, "project_id"),
    name: requireString(value, "name"),
    created_at: requireString(value, "created_at"),
    updated_at: requireString(value, "updated_at"),
    last_session_id: legacy
      ? requireString(value, "last_session_id")
      : requireNullableString(value, "last_session_id"),
    new_chat_draft: legacy
      ? ""
      : requireString(value, "new_chat_draft", true),
    new_chat_model: hasModelSelection
      ? parseModelSelection(value.new_chat_model)
      : { ...DEFAULT_MODEL_SELECTION },
    new_chat_reasoning_effort: hasReasoningEffort
      ? parseReasoningEffort(value.new_chat_reasoning_effort)
      : DEFAULT_REASONING_EFFORT,
  };
}

function parseSessionRecord(
  value: unknown,
  hasModelSelection: boolean,
  hasReasoningEffort: boolean,
): SessionRecord {
  if (!isRecord(value)) throw new Error("Session record must be an object.");
  return {
    session_id: requireString(value, "session_id"),
    project_id: requireString(value, "project_id"),
    title: requireString(value, "title"),
    title_is_custom: requireBoolean(value, "title_is_custom"),
    created_at: requireString(value, "created_at"),
    updated_at: requireString(value, "updated_at"),
    selected_model: hasModelSelection
      ? parseModelSelection(value.selected_model)
      : { ...DEFAULT_MODEL_SELECTION },
    reasoning_effort: hasReasoningEffort
      ? parseReasoningEffort(value.reasoning_effort)
      : DEFAULT_REASONING_EFFORT,
  };
}

function parseModelSelection(value: unknown): ModelSelection {
  if (!isRecord(value)) throw new Error("Model selection must be an object.");
  return {
    provider_id: requireString(value, "provider_id"),
    model_id: requireString(value, "model_id"),
  };
}

function parseSessionDocument(
  value: unknown,
  legacy: boolean,
): { document: SessionDocument; was_migrated: boolean } {
  if (!isRecord(value)) throw new Error("Session document must be an object.");
  const formatVersion = value.format_version;
  const isLegacyFormat =
    formatVersion === LEGACY_SESSION_DOCUMENT_FORMAT_VERSION ||
    formatVersion === TRANSCRIPT_SESSION_DOCUMENT_FORMAT_VERSION ||
    formatVersion === TIMELINE_SESSION_DOCUMENT_FORMAT_VERSION ||
    formatVersion === LINEAR_SESSION_DOCUMENT_FORMAT_VERSION;
  if (
    formatVersion !== SESSION_DOCUMENT_FORMAT_VERSION &&
    formatVersion !== RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION &&
    (!isLegacyFormat ||
      (legacy && formatVersion !== LEGACY_SESSION_DOCUMENT_FORMAT_VERSION))
  ) {
    throw new Error("Unsupported session document format version.");
  }
  const sessionId = requireString(value, "session_id");
  const projectId = requireString(value, "project_id");
  const inputDraft =
    formatVersion === LEGACY_SESSION_DOCUMENT_FORMAT_VERSION
      ? ""
      : requireString(value, "input_draft", true);
  if (
    formatVersion === RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION &&
    isTransitionalTimelineDocument(value)
  ) {
    const timeline = parseTimeline(value.timeline);
    const parsedHistory = parseSessionHistory(value.history, timeline);
    return {
      document: {
        format_version: SESSION_DOCUMENT_FORMAT_VERSION,
        session_id: sessionId,
        project_id: projectId,
        input_draft: inputDraft,
        timeline,
        history: parsedHistory.history,
      },
      was_migrated: true,
    };
  }
  if (formatVersion === RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION) {
    for (const forbidden of ["timeline", "history", "runtime_state"]) {
      if (Object.prototype.hasOwnProperty.call(value, forbidden)) {
        throw new Error(
          `Runtime session documents cannot persist ${forbidden}.`,
        );
      }
    }
    return {
      document: {
        format_version: RUNTIME_SESSION_DOCUMENT_FORMAT_VERSION,
        session_id: sessionId,
        project_id: projectId,
        input_draft: inputDraft,
        runtime_id: requireString(value, "runtime_id"),
        message_count: requireNonNegativeInteger(value, "message_count"),
        ...(optionalString(value, "migration_source_session_id") === undefined
          ? {}
          : {
              migration_source_session_id: requireString(
                value,
                "migration_source_session_id",
              ),
            }),
      },
      was_migrated: false,
    };
  }
  if (formatVersion === SESSION_DOCUMENT_FORMAT_VERSION) {
    const timeline = parseTimeline(value.timeline);
    const parsedHistory = parseSessionHistory(value.history, timeline);
    return {
      document: {
        format_version: SESSION_DOCUMENT_FORMAT_VERSION,
        session_id: sessionId,
        project_id: projectId,
        input_draft: inputDraft,
        timeline,
        history: parsedHistory.history,
      },
      was_migrated: parsedHistory.was_migrated,
    };
  }
  if (
    formatVersion === TIMELINE_SESSION_DOCUMENT_FORMAT_VERSION ||
    formatVersion === LINEAR_SESSION_DOCUMENT_FORMAT_VERSION
  ) {
    const timeline =
      formatVersion === TIMELINE_SESSION_DOCUMENT_FORMAT_VERSION
        ? migrateNormalizedTimeline(value.timeline)
        : parseTimeline(value.timeline);
    return {
      document: {
        format_version: SESSION_DOCUMENT_FORMAT_VERSION,
        session_id: sessionId,
        project_id: projectId,
        input_draft: inputDraft,
        timeline,
        history: createSessionHistory(timeline),
      },
      was_migrated: true,
    };
  }

  const messages = requireArray(value, "messages").map(parseChatMessage);
  const activities = requireArray(value, "activities").map((activity, index) =>
    parseToolActivity(activity, `legacy:${sessionId}:${index}`),
  );
  const timeline = migrateLegacyTimeline(
    sessionId,
    messages,
    activities,
    requireArray(value, "agent_messages"),
  );
  return {
    document: {
      format_version: SESSION_DOCUMENT_FORMAT_VERSION,
      session_id: sessionId,
      project_id: projectId,
      input_draft: inputDraft,
      timeline,
      history: createSessionHistory(timeline),
    },
    was_migrated: true,
  };
}

function isTransitionalTimelineDocument(
  value: Record<string, unknown>,
): boolean {
  // A pre-release bridge briefly used format 6 for legacy timeline documents
  // before format 6 was reassigned to runtime references. Only recover the
  // unambiguous shape that contains no runtime metadata.
  return (
    Object.prototype.hasOwnProperty.call(value, "timeline") &&
    Object.prototype.hasOwnProperty.call(value, "history") &&
    !Object.prototype.hasOwnProperty.call(value, "runtime_id") &&
    !Object.prototype.hasOwnProperty.call(value, "message_count") &&
    !Object.prototype.hasOwnProperty.call(value, "runtime_state")
  );
}

function migrateNormalizedTimeline(value: unknown): TimelineEntry[] {
  if (!Array.isArray(value)) return parseTimeline(value);
  const timeline = value.map((entry) => {
    if (
      !isRecord(entry) ||
      entry.type !== "tool_result" ||
      !isRecord(entry.file_change) ||
      Object.prototype.hasOwnProperty.call(entry.file_change, "tool_name") ||
      (entry.tool_name !== "write_file" &&
        entry.tool_name !== "replace_text")
    ) {
      return entry;
    }
    return {
      ...entry,
      file_change: {
        ...entry.file_change,
        tool_name: entry.tool_name,
      },
    };
  });
  return parseTimeline(timeline);
}

function findEmptyLegacyDocuments(documents: unknown[]): Set<string> {
  const emptyDocuments = new Set<string>();
  for (const candidate of documents) {
    const document = requireRecord(candidate, "Legacy session document");
    if (
      requireArray(document, "messages").length === 0 &&
      requireArray(document, "activities").length === 0 &&
      requireArray(document, "agent_messages").length === 0
    ) {
      emptyDocuments.add(requireString(document, "session_id"));
    }
  }
  return emptyDocuments;
}

function removeLegacyPlaceholderSessions(
  state: ProjectStoreState,
  emptyLegacyDocuments: Set<string>,
): void {
  const documents = new Map(
    state.documents.map((document) => [document.session_id, document]),
  );
  const placeholderIds = new Set(
    state.sessions
      .filter((session) => {
        const document = documents.get(session.session_id);
        return (
          emptyLegacyDocuments.has(session.session_id) &&
          document !== undefined &&
          isUnsubmittedNewChat(session, document)
        );
      })
      .map((session) => session.session_id),
  );
  if (placeholderIds.size === 0) return;

  state.sessions = state.sessions.filter(
    (session) => !placeholderIds.has(session.session_id),
  );
  state.documents = state.documents.filter(
    (document) => !placeholderIds.has(document.session_id),
  );
  for (const project of state.projects) {
    if (project.last_session_id && placeholderIds.has(project.last_session_id)) {
      project.last_session_id = null;
    }
  }
  if (state.active_session_id && placeholderIds.has(state.active_session_id)) {
    state.active_session_id = null;
  }
}

function isUnsubmittedNewChat(
  session: SessionRecord,
  document: SessionDocument,
): boolean {
  return (
    session.title === "New chat" &&
    !session.title_is_custom &&
    sessionDocumentMessageCount(document) === 0
  );
}

type LegacyChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  status: "streaming" | "complete" | "aborted" | "error";
};

type LegacyToolActivity = {
  activity_id: string;
  tool_call_id: string;
  message_id: string;
  tool_name: string;
  label: string;
  status: "running" | "complete" | "error";
  summary?: string;
  file_change?: WorkspaceChangeSummary;
};

function parseChatMessage(value: unknown): LegacyChatMessage {
  if (!isRecord(value)) throw new Error("Stored chat message must be an object.");
  const role = value.role;
  const status = value.status;
  if (role !== "user" && role !== "assistant") {
    throw new Error("Stored chat message role is invalid.");
  }
  if (
    status !== "streaming" &&
    status !== "complete" &&
    status !== "aborted" &&
    status !== "error"
  ) {
    throw new Error("Stored chat message status is invalid.");
  }
  return {
    id: requireString(value, "id"),
    role,
    content: requireString(value, "content", true),
    created_at: requireString(value, "created_at"),
    status,
  };
}

function parseToolActivity(
  value: unknown,
  legacyActivityId: string,
): LegacyToolActivity {
  if (!isRecord(value)) throw new Error("Stored tool activity must be an object.");
  const status = value.status;
  if (status !== "running" && status !== "complete" && status !== "error") {
    throw new Error("Stored tool activity status is invalid.");
  }
  const summary = optionalString(value, "summary", true);
  const toolCallId = requireString(value, "tool_call_id");
  const toolName = requireString(value, "tool_name");
  const fileChange =
    value.file_change === undefined
      ? undefined
      : parseWorkspaceChangeSummary(value.file_change, toolName);
  if (fileChange && fileChange.tool_call_id !== toolCallId) {
    throw new Error(
      "Stored tool activity file_change must match tool_call_id.",
    );
  }
  return {
    activity_id:
      value.activity_id === undefined
        ? legacyActivityId
        : requireString(value, "activity_id"),
    tool_call_id: toolCallId,
    message_id: requireString(value, "message_id"),
    tool_name: toolName,
    label: requireString(value, "label"),
    status,
    ...(summary === undefined ? {} : { summary }),
    ...(fileChange === undefined ? {} : { file_change: fileChange }),
  };
}

function migrateLegacyTimeline(
  sessionId: string,
  messages: LegacyChatMessage[],
  activities: LegacyToolActivity[],
  agentMessages: unknown[],
): TimelineEntry[] {
  if (agentMessages.length > 0) {
    try {
      return migrateAgentTranscript(
        sessionId,
        messages,
        activities,
        agentMessages,
      );
    } catch {
      // v2 kept a redundant UI snapshot specifically so a damaged agent
      // transcript would not make the session unreadable.
    }
  }
  return migrateLegacySnapshot(sessionId, messages, activities);
}

type PendingLegacyToolCall = {
  block_id: string;
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  activity?: LegacyToolActivity;
};

type LegacyMessageRun = {
  user: LegacyChatMessage;
  assistant?: LegacyChatMessage;
};

function migrateAgentTranscript(
  sessionId: string,
  messages: LegacyChatMessage[],
  activities: LegacyToolActivity[],
  agentMessages: unknown[],
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  const claimedEntryIds = new Set<string>();
  const legacyRuns = groupLegacyMessageRuns(messages);
  const remainingActivities = [...activities];
  const pendingToolCalls = new Map<string, PendingLegacyToolCall[]>();
  let runIndex = -1;
  let currentRunId: string | undefined;
  let currentLegacyRun: LegacyMessageRun | undefined;
  let claimedAssistantIdForRun = false;

  for (const [messageIndex, candidate] of agentMessages.entries()) {
    const message = requireRecord(candidate, "Stored agent message");
    const createdAt = legacyTimestampToIso(message.timestamp);
    switch (message.role) {
      case "user": {
        runIndex += 1;
        currentRunId = legacyRunId(sessionId, runIndex);
        currentLegacyRun = legacyRuns[runIndex];
        claimedAssistantIdForRun = false;
        timeline.push({
          type: "user_message",
          entry_id: claimLegacyId(
            currentLegacyRun?.user.id,
            `legacy:${sessionId}:entry:${messageIndex}`,
            claimedEntryIds,
          ),
          run_id: currentRunId,
          created_at: createdAt,
          content: decodeLegacyTextContent(message.content, "user"),
        });
        break;
      }
      case "assistant": {
        if (currentRunId === undefined) {
          throw new Error("Stored transcript starts without a user message.");
        }
        const preferredId = claimedAssistantIdForRun
          ? undefined
          : currentLegacyRun?.assistant?.id;
        if (!claimedAssistantIdForRun) {
          claimedAssistantIdForRun = true;
        }
        const blocks = decodeLegacyAssistantBlocks(
          sessionId,
          messageIndex,
          currentRunId,
          message,
          remainingActivities,
          currentLegacyRun?.assistant?.id,
          pendingToolCalls,
        );
        timeline.push({
          type: "assistant_message",
          entry_id: claimLegacyId(
            preferredId,
            `legacy:${sessionId}:entry:${messageIndex}`,
            claimedEntryIds,
          ),
          run_id: currentRunId,
          created_at: createdAt,
          status: legacyAssistantStatus(message.stop_reason),
          api: requireString(message, "api"),
          provider: requireString(message, "provider"),
          model: requireString(message, "model"),
          ...optionalStoredString(message, "response_model"),
          ...optionalStoredString(message, "response_id"),
          usage: decodeLegacyAssistantUsage(message.usage),
          stop_reason: normalizeLegacyStopReason(message.stop_reason),
          ...optionalStoredString(message, "error_message", true),
          blocks,
        });
        break;
      }
      case "tool_result": {
        if (currentRunId === undefined) {
          throw new Error("Stored transcript starts without a user message.");
        }
        const toolCallId = requireString(message, "tool_call_id");
        const pending = pendingToolCalls.get(toolCallId)?.shift();
        if (!pending) {
          throw new Error("Stored tool result has no earlier tool call.");
        }
        const toolName = requireString(message, "tool_name");
        if (pending.tool_name !== toolName || pending.run_id !== currentRunId) {
          throw new Error("Stored tool result does not match its tool call.");
        }
        const summary = pending.activity?.summary;
        const fileChange = pending.activity?.file_change;
        timeline.push({
          type: "tool_result",
          entry_id: claimLegacyId(
            undefined,
            `legacy:${sessionId}:entry:${messageIndex}`,
            claimedEntryIds,
          ),
          run_id: currentRunId,
          created_at: createdAt,
          tool_call_block_id: pending.block_id,
          tool_call_id: toolCallId,
          tool_name: toolName,
          content: decodeLegacyTextContent(message.content, "tool result"),
          is_error: requireBoolean(message, "is_error"),
          ...(summary === undefined ? {} : { summary }),
          ...(fileChange === undefined ? {} : { file_change: fileChange }),
        });
        break;
      }
      default:
        throw new Error("Stored agent message role is invalid.");
    }
  }

  return parseTimeline(timeline);
}

function decodeLegacyAssistantBlocks(
  sessionId: string,
  messageIndex: number,
  runId: string,
  message: Record<string, unknown>,
  remainingActivities: LegacyToolActivity[],
  legacyMessageId: string | undefined,
  pendingToolCalls: Map<string, PendingLegacyToolCall[]>,
): AssistantBlock[] {
  return requireArray(message, "content").map((candidate, blockIndex) => {
    const content = requireRecord(candidate, "Stored assistant content block");
    const blockId = `legacy:${sessionId}:entry:${messageIndex}:block:${blockIndex}`;
    switch (content.type) {
      case "text":
        return {
          type: "assistant_text",
          block_id: blockId,
          text: requireString(content, "text", true),
          ...optionalStoredString(content, "text_signature", true),
        };
      case "thinking": {
        const signature = optionalString(
          content,
          "thinking_signature",
          true,
        );
        const redacted = optionalBoolean(content, "redacted");
        return {
          type: "reasoning",
          block_id: blockId,
          text: requireString(content, "thinking", true),
          ...(signature === undefined
            ? {}
            : { thinking_signature: signature }),
          ...(redacted === undefined ? {} : { redacted }),
        };
      }
      case "tool_call": {
        const toolCallId = requireString(content, "id");
        const toolName = requireString(content, "name");
        const activity = takeLegacyActivity(
          remainingActivities,
          toolCallId,
          toolName,
          legacyMessageId,
        );
        const pending: PendingLegacyToolCall = {
          block_id: blockId,
          run_id: runId,
          tool_call_id: toolCallId,
          tool_name: toolName,
          ...(activity === undefined ? {} : { activity }),
        };
        const queue = pendingToolCalls.get(toolCallId) ?? [];
        queue.push(pending);
        pendingToolCalls.set(toolCallId, queue);
        const thoughtSignature = optionalString(
          content,
          "thought_signature",
          true,
        );
        return {
          type: "tool_call",
          block_id: blockId,
          tool_call_id: toolCallId,
          tool_name: toolName,
          arguments: structuredClone(
            requireRecord(content.arguments, "Stored tool arguments"),
          ),
          ...(thoughtSignature === undefined
            ? {}
            : { thought_signature: thoughtSignature }),
          ...(activity === undefined ? {} : { label: activity.label }),
        };
      }
      default:
        throw new Error("Stored assistant content block type is invalid.");
    }
  });
}

function migrateLegacySnapshot(
  sessionId: string,
  messages: LegacyChatMessage[],
  activities: LegacyToolActivity[],
): TimelineEntry[] {
  if (messages.length === 0) return [];

  const timeline: TimelineEntry[] = [];
  const claimedEntryIds = new Set<string>();
  const activitiesByMessageId = new Map<string, LegacyToolActivity[]>();
  for (const activity of activities) {
    const grouped = activitiesByMessageId.get(activity.message_id) ?? [];
    grouped.push(activity);
    activitiesByMessageId.set(activity.message_id, grouped);
  }
  let runIndex = -1;
  let currentRunId: string | undefined;

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "user") {
      runIndex += 1;
      currentRunId = legacyRunId(sessionId, runIndex);
      timeline.push({
        type: "user_message",
        entry_id: claimLegacyId(
          message.id,
          `legacy:${sessionId}:fallback:entry:${messageIndex}`,
          claimedEntryIds,
        ),
        run_id: currentRunId,
        created_at: message.created_at,
        content: message.content,
      });
      continue;
    }
    if (currentRunId === undefined) {
      throw new Error("Stored message snapshot starts without a user message.");
    }

    const messageActivities = activitiesByMessageId.get(message.id) ?? [];
    const blocks: AssistantBlock[] = [
      {
        type: "assistant_text",
        block_id: `legacy:${sessionId}:fallback:entry:${messageIndex}:block:text`,
        text: message.content,
      },
      ...messageActivities.map(
        (activity, activityIndex): ToolCallBlock => ({
          type: "tool_call",
          block_id:
            `legacy:${sessionId}:fallback:entry:${messageIndex}` +
            `:block:tool:${activityIndex}`,
          tool_call_id: activity.tool_call_id,
          tool_name: activity.tool_name,
          arguments: {},
          label: activity.label,
        }),
      ),
    ];
    const assistantEntry: AssistantMessageEntry = {
      type: "assistant_message",
      entry_id: claimLegacyId(
        message.id,
        `legacy:${sessionId}:fallback:entry:${messageIndex}`,
        claimedEntryIds,
      ),
      run_id: currentRunId,
      created_at: message.created_at,
      status: message.status,
      api: "legacy",
      provider: "legacy",
      model: "legacy",
      usage: emptyAssistantUsage(),
      ...(message.status === "streaming"
        ? {}
        : {
            stop_reason:
              message.status === "complete" ? "stop" : message.status,
          }),
      blocks,
    };
    timeline.push(assistantEntry);

    const mayRemainPending = messageIndex === messages.length - 1;
    for (const [activityIndex, activity] of messageActivities.entries()) {
      if (activity.status === "running" && mayRemainPending) continue;
      const block = blocks[activityIndex + 1];
      if (!block || block.type !== "tool_call") {
        throw new Error("Stored activity could not be migrated.");
      }
      const summary =
        activity.status === "running"
          ? (activity.summary ??
            "Tool execution was interrupted before its result was persisted.")
          : activity.summary;
      timeline.push({
        type: "tool_result",
        entry_id: claimLegacyId(
          undefined,
          `legacy:${sessionId}:fallback:entry:${messageIndex}` +
            `:result:${activityIndex}`,
          claimedEntryIds,
        ),
        run_id: currentRunId,
        created_at: message.created_at,
        tool_call_block_id: block.block_id,
        tool_call_id: activity.tool_call_id,
        tool_name: activity.tool_name,
        content: summary ?? "",
        is_error: activity.status !== "complete",
        ...(summary === undefined ? {} : { summary }),
        ...(activity.file_change === undefined
          ? {}
          : { file_change: activity.file_change }),
      });
    }
  }

  return parseTimeline(timeline);
}

function groupLegacyMessageRuns(
  messages: LegacyChatMessage[],
): LegacyMessageRun[] {
  const runs: LegacyMessageRun[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      runs.push({ user: message });
      continue;
    }
    const currentRun = runs.at(-1);
    if (currentRun && currentRun.assistant === undefined) {
      currentRun.assistant = message;
    }
  }
  return runs;
}

function takeLegacyActivity(
  activities: LegacyToolActivity[],
  toolCallId: string,
  toolName: string,
  legacyMessageId: string | undefined,
): LegacyToolActivity | undefined {
  const activityIndex = activities.findIndex(
    (activity) =>
      activity.tool_call_id === toolCallId &&
      activity.tool_name === toolName &&
      (legacyMessageId === undefined ||
        activity.message_id === legacyMessageId),
  );
  if (activityIndex === -1) return undefined;
  return activities.splice(activityIndex, 1)[0];
}

function decodeLegacyTextContent(
  value: unknown,
  label: "user" | "tool result",
): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new Error(`Stored ${label} content is invalid.`);
  }
  return value
    .map((candidate) => {
      const content = requireRecord(candidate, `Stored ${label} content block`);
      if (content.type !== "text") {
        throw new Error(`Stored ${label} content block is unsupported.`);
      }
      return requireString(content, "text", true);
    })
    .join("");
}

function decodeLegacyAssistantUsage(
  value: unknown,
): AssistantMessageEntry["usage"] {
  const usage = requireRecord(value, "Stored assistant usage");
  const cost = requireRecord(usage.cost, "Stored assistant usage cost");
  return {
    input: requireNonNegativeNumber(usage, "input"),
    output: requireNonNegativeNumber(usage, "output"),
    cache_read: requireNonNegativeNumber(usage, "cache_read"),
    cache_write: requireNonNegativeNumber(usage, "cache_write"),
    total_tokens: requireNonNegativeNumber(usage, "total_tokens"),
    cost: {
      input: requireNonNegativeNumber(cost, "input"),
      output: requireNonNegativeNumber(cost, "output"),
      cache_read: requireNonNegativeNumber(cost, "cache_read"),
      cache_write: requireNonNegativeNumber(cost, "cache_write"),
      total: requireNonNegativeNumber(cost, "total"),
    },
  };
}

function normalizeLegacyStopReason(
  value: unknown,
): NonNullable<AssistantMessageEntry["stop_reason"]> {
  switch (value) {
    case "stop":
    case "length":
    case "error":
    case "aborted":
      return value;
    case "toolUse":
    case "tool_use":
      return "tool_use";
    default:
      throw new Error("Stored assistant stop_reason is invalid.");
  }
}

function legacyAssistantStatus(
  stopReason: unknown,
): AssistantMessageEntry["status"] {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  normalizeLegacyStopReason(stopReason);
  return "complete";
}

function legacyTimestampToIso(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Stored message timestamp must be a finite number.");
  }
  try {
    return new Date(value).toISOString();
  } catch {
    throw new Error("Stored message timestamp is outside the supported range.");
  }
}

function legacyRunId(sessionId: string, runIndex: number): string {
  return `legacy:${sessionId}:run:${runIndex}`;
}

function claimLegacyId(
  preferred: string | undefined,
  fallback: string,
  claimed: Set<string>,
): string {
  let candidate = preferred ?? fallback;
  let suffix = 1;
  while (claimed.has(candidate)) {
    candidate = `${fallback}:${suffix}`;
    suffix += 1;
  }
  claimed.add(candidate);
  return candidate;
}

function optionalStoredString<TField extends string>(
  value: Record<string, unknown>,
  field: TField,
  allowEmpty = false,
): Partial<Record<TField, string>> {
  const candidate = optionalString(value, field, allowEmpty);
  return candidate === undefined ? {} : { [field]: candidate } as Partial<
    Record<TField, string>
  >;
}

function parseWorkspaceChangeSummary(
  value: unknown,
  legacyToolName: string,
): WorkspaceChangeSummary {
  if (!isRecord(value)) {
    throw new Error("Stored workspace change summary must be an object.");
  }
  const changeKind = value.change_kind;
  if (changeKind !== "created" && changeKind !== "updated") {
    throw new Error("Stored workspace change kind is invalid.");
  }
  return {
    change_id: requireString(value, "change_id"),
    tool_call_id: requireString(value, "tool_call_id"),
    tool_name:
      changeKind === "updated" && legacyToolName === "replace_text"
        ? "replace_text"
        : "write_file",
    path: requireString(value, "path"),
    change_kind: changeKind,
    additions: requireNonNegativeInteger(value, "additions"),
    deletions: requireNonNegativeInteger(value, "deletions"),
    byte_size: requireNonNegativeInteger(value, "byte_size"),
  };
}

function uniqueMap<T>(
  values: T[],
  getId: (value: T) => string,
  label: string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) {
    const id = getId(value);
    if (map.has(id)) throw new Error(`Duplicate ${label} id: ${id}`);
    map.set(id, value);
  }
  return map;
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
  if (!Number.isInteger(candidate)) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return candidate;
}

function requireNonNegativeNumber(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = value[field];
  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate < 0
  ) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return candidate;
}

function requireNullableString(
  value: Record<string, unknown>,
  field: string,
): string | null {
  if (value[field] === null) return null;
  return requireString(value, field);
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
  allowEmpty = false,
): string | undefined {
  if (value[field] === undefined) return undefined;
  return requireString(value, field, allowEmpty);
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

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
