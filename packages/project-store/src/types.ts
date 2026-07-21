import type { ChatMessage, ToolActivity } from "@researchbox/protocol";

export const PROJECT_STORE_SCHEMA_VERSION = 2 as const;
export const SESSION_DOCUMENT_FORMAT_VERSION = 2 as const;

const LEGACY_PROJECT_STORE_SCHEMA_VERSION = 1 as const;
const LEGACY_SESSION_DOCUMENT_FORMAT_VERSION = 1 as const;

export type ProjectRecord = {
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  last_session_id: string | null;
  new_chat_draft: string;
};

export type SessionRecord = {
  session_id: string;
  project_id: string;
  title: string;
  title_is_custom: boolean;
  created_at: string;
  updated_at: string;
};

export type SessionDocument = {
  format_version: typeof SESSION_DOCUMENT_FORMAT_VERSION;
  session_id: string;
  project_id: string;
  input_draft: string;
  messages: ChatMessage[];
  activities: ToolActivity[];
  agent_messages: unknown[];
};

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
    schemaVersion !== LEGACY_PROJECT_STORE_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported project store schema version.");
  }

  const legacy = schemaVersion === LEGACY_PROJECT_STORE_SCHEMA_VERSION;
  const state: ProjectStoreState = {
    schema_version: PROJECT_STORE_SCHEMA_VERSION,
    state_revision: requireNonNegativeInteger(value, "state_revision"),
    active_project_id: requireString(value, "active_project_id"),
    active_session_id: legacy
      ? requireString(value, "active_session_id")
      : requireNullableString(value, "active_session_id"),
    projects: requireArray(value, "projects").map((project) =>
      parseProjectRecord(project, legacy),
    ),
    sessions: requireArray(value, "sessions").map(parseSessionRecord),
    documents: requireArray(value, "documents").map((document) =>
      parseSessionDocument(document, legacy),
    ),
  };

  if (legacy) removeLegacyPlaceholderSessions(state);
  assertProjectStoreInvariants(state);
  return { state, was_migrated: legacy };
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
  if (state.active_session_id === null) {
    if (activeProject.last_session_id !== null) {
      throw new Error("Active new chat must be the active project's last view.");
    }
  } else {
    const activeSession = sessions.get(state.active_session_id);
    if (!activeSession) throw new Error("Active session does not exist.");
    if (activeSession.project_id !== activeProject.project_id) {
      throw new Error("Active session does not belong to the active project.");
    }
    if (activeProject.last_session_id !== activeSession.session_id) {
      throw new Error("Active session must be the active project's last session.");
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
  }

  if (documents.size !== sessions.size) {
    throw new Error("Project store contains an orphan session document.");
  }
}

function parseProjectRecord(value: unknown, legacy: boolean): ProjectRecord {
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
  };
}

function parseSessionRecord(value: unknown): SessionRecord {
  if (!isRecord(value)) throw new Error("Session record must be an object.");
  return {
    session_id: requireString(value, "session_id"),
    project_id: requireString(value, "project_id"),
    title: requireString(value, "title"),
    title_is_custom: requireBoolean(value, "title_is_custom"),
    created_at: requireString(value, "created_at"),
    updated_at: requireString(value, "updated_at"),
  };
}

function parseSessionDocument(
  value: unknown,
  legacy: boolean,
): SessionDocument {
  if (!isRecord(value)) throw new Error("Session document must be an object.");
  const expectedFormat = legacy
    ? LEGACY_SESSION_DOCUMENT_FORMAT_VERSION
    : SESSION_DOCUMENT_FORMAT_VERSION;
  if (value.format_version !== expectedFormat) {
    throw new Error("Unsupported session document format version.");
  }
  const messages = requireArray(value, "messages").map(parseChatMessage);
  const activities = requireArray(value, "activities").map(parseToolActivity);
  return {
    format_version: SESSION_DOCUMENT_FORMAT_VERSION,
    session_id: requireString(value, "session_id"),
    project_id: requireString(value, "project_id"),
    input_draft: legacy ? "" : requireString(value, "input_draft", true),
    messages,
    activities,
    agent_messages: structuredClone(requireArray(value, "agent_messages")),
  };
}

function removeLegacyPlaceholderSessions(state: ProjectStoreState): void {
  const documents = new Map(
    state.documents.map((document) => [document.session_id, document]),
  );
  const placeholderIds = new Set(
    state.sessions
      .filter((session) => {
        const document = documents.get(session.session_id);
        return document !== undefined && isUnsubmittedNewChat(session, document);
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
    document.messages.length === 0 &&
    document.activities.length === 0 &&
    document.agent_messages.length === 0
  );
}

function parseChatMessage(value: unknown): ChatMessage {
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

function parseToolActivity(value: unknown): ToolActivity {
  if (!isRecord(value)) throw new Error("Stored tool activity must be an object.");
  const status = value.status;
  if (status !== "running" && status !== "complete" && status !== "error") {
    throw new Error("Stored tool activity status is invalid.");
  }
  const summary = optionalString(value, "summary", true);
  return {
    tool_call_id: requireString(value, "tool_call_id"),
    message_id: requireString(value, "message_id"),
    tool_name: requireString(value, "tool_name"),
    label: requireString(value, "label"),
    status,
    ...(summary === undefined ? {} : { summary }),
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

function requireNonNegativeInteger(
  value: Record<string, unknown>,
  field: string,
): number {
  const candidate = value[field];
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < 0
  ) {
    throw new Error(`${field} must be a non-negative integer.`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
