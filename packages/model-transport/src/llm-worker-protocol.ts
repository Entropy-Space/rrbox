import {
  parseModelDescriptors,
  parseModelRequest,
  parseModelStreamEvent,
  type ModelDescriptor,
  type ModelRequest,
  type ModelStreamEvent,
} from "./model-transport.ts";

export const LLM_WORKER_PROTOCOL_VERSION = 4 as const;

type CommandEnvelope<TType extends string, TPayload extends object> = {
  protocol_version: typeof LLM_WORKER_PROTOCOL_VERSION;
  type: TType;
  payload: TPayload;
};

type StreamCommandEnvelope<TType extends string, TPayload extends object> =
  CommandEnvelope<TType, TPayload> & { stream_id: string };

type RequestCommandEnvelope<TType extends string, TPayload extends object> =
  CommandEnvelope<TType, TPayload> & { request_id: string };

export type LlmWorkerCommand =
  | StreamCommandEnvelope<"stream_start", { model_request: ModelRequest }>
  | StreamCommandEnvelope<"stream_abort", Record<string, never>>
  | RequestCommandEnvelope<"models_request", { provider_id: string }>
  | RequestCommandEnvelope<"models_abort", Record<string, never>>;

type EventEnvelope<TType extends string, TPayload extends object> = {
  protocol_version: typeof LLM_WORKER_PROTOCOL_VERSION;
  event_id: string;
  type: TType;
  payload: TPayload;
};

type StreamEventEnvelope<TType extends string, TPayload extends object> =
  EventEnvelope<TType, TPayload> & {
    stream_id: string;
  };

type RequestEventEnvelope<TType extends string, TPayload extends object> =
  EventEnvelope<TType, TPayload> & {
    request_id: string;
  };

export type LlmWorkerEvent =
  | StreamEventEnvelope<
      "stream_event",
      { model_event: ModelStreamEvent }
    >
  | RequestEventEnvelope<
      "models_result",
      { provider_id: string; models: ModelDescriptor[] }
    >
  | RequestEventEnvelope<
      "models_error",
      { provider_id: string; error_message: string }
    >
  | StreamEventEnvelope<
      "stream_finished",
      {
        status: "complete" | "aborted" | "error";
        error_message?: string;
      }
    >
  | EventEnvelope<
      "protocol_error",
      { code: "invalid_llm_command"; message: string }
    >;

export function createLlmStreamStart(
  streamId: string,
  modelRequest: ModelRequest,
): Extract<LlmWorkerCommand, { type: "stream_start" }> {
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    stream_id: requireIdentifier(streamId, "stream_id"),
    type: "stream_start",
    payload: { model_request: modelRequest },
  };
}

export function createLlmStreamAbort(
  streamId: string,
): Extract<LlmWorkerCommand, { type: "stream_abort" }> {
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    stream_id: requireIdentifier(streamId, "stream_id"),
    type: "stream_abort",
    payload: {},
  };
}

export function createLlmModelsRequest(
  requestId: string,
  providerId: string,
): Extract<LlmWorkerCommand, { type: "models_request" }> {
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    request_id: requireIdentifier(requestId, "request_id"),
    type: "models_request",
    payload: { provider_id: requireIdentifier(providerId, "provider_id") },
  };
}

export function createLlmModelsAbort(
  requestId: string,
): Extract<LlmWorkerCommand, { type: "models_abort" }> {
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    request_id: requireIdentifier(requestId, "request_id"),
    type: "models_abort",
    payload: {},
  };
}

export function createLlmStreamEvent(
  streamId: string,
  modelEvent: ModelStreamEvent,
): Extract<LlmWorkerEvent, { type: "stream_event" }> {
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    stream_id: requireIdentifier(streamId, "stream_id"),
    type: "stream_event",
    payload: { model_event: modelEvent },
  };
}

export function createLlmStreamFinished(
  streamId: string,
  status: "complete" | "aborted",
): Extract<LlmWorkerEvent, { type: "stream_finished" }>;
export function createLlmStreamFinished(
  streamId: string,
  status: "error",
  errorMessage: string,
): Extract<LlmWorkerEvent, { type: "stream_finished" }>;
export function createLlmStreamFinished(
  streamId: string,
  status: "complete" | "aborted" | "error",
  errorMessage?: string,
): Extract<LlmWorkerEvent, { type: "stream_finished" }> {
  if (status === "error" && errorMessage === undefined) {
    throw new Error("An errored LLM stream requires error_message.");
  }
  if (status !== "error" && errorMessage !== undefined) {
    throw new Error("Only an errored LLM stream may include error_message.");
  }
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    stream_id: requireIdentifier(streamId, "stream_id"),
    type: "stream_finished",
    payload: {
      status,
      ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
    },
  };
}

export function createLlmModelsResult(
  requestId: string,
  providerId: string,
  models: ModelDescriptor[],
): Extract<LlmWorkerEvent, { type: "models_result" }> {
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    request_id: requireIdentifier(requestId, "request_id"),
    type: "models_result",
    payload: {
      provider_id: requireIdentifier(providerId, "provider_id"),
      models: parseModelDescriptors(models),
    },
  };
}

export function createLlmModelsError(
  requestId: string,
  providerId: string,
  errorMessage: string,
): Extract<LlmWorkerEvent, { type: "models_error" }> {
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    request_id: requireIdentifier(requestId, "request_id"),
    type: "models_error",
    payload: {
      provider_id: requireIdentifier(providerId, "provider_id"),
      error_message: requireNonEmptyString(errorMessage, "error_message"),
    },
  };
}

export function createLlmProtocolError(
  message: string,
): Extract<LlmWorkerEvent, { type: "protocol_error" }> {
  return {
    protocol_version: LLM_WORKER_PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    type: "protocol_error",
    payload: {
      code: "invalid_llm_command",
      message,
    },
  };
}

export function parseLlmWorkerCommand(value: unknown): LlmWorkerCommand {
  const envelope = parseEnvelope(value, "LLM worker command");

  switch (envelope.type) {
    case "stream_start":
      return createLlmStreamStart(
        requireIdentifier(envelope.stream_id, "stream_id"),
        parseModelRequest(envelope.payload.model_request),
      );
    case "stream_abort":
      return createLlmStreamAbort(
        requireIdentifier(envelope.stream_id, "stream_id"),
      );
    case "models_request":
      return createLlmModelsRequest(
        requireIdentifier(envelope.request_id, "request_id"),
        requireIdentifier(envelope.payload.provider_id, "provider_id"),
      );
    case "models_abort":
      return createLlmModelsAbort(
        requireIdentifier(envelope.request_id, "request_id"),
      );
    default:
      throw new Error(`Unknown LLM worker command: ${String(envelope.type)}`);
  }
}

export function parseLlmWorkerEvent(value: unknown): LlmWorkerEvent {
  const envelope = parseEnvelope(value, "LLM worker event");
  const eventId = requireIdentifier(envelope.event_id, "event_id");

  switch (envelope.type) {
    case "stream_event":
      return {
        protocol_version: LLM_WORKER_PROTOCOL_VERSION,
        event_id: eventId,
        stream_id: requireIdentifier(envelope.stream_id, "stream_id"),
        type: "stream_event",
        payload: {
          model_event: parseModelStreamEvent(envelope.payload.model_event),
        },
      };
    case "stream_finished": {
      const status = envelope.payload.status;
      if (status !== "complete" && status !== "aborted" && status !== "error") {
        throw new Error("Invalid LLM stream status.");
      }
      const errorMessage =
        envelope.payload.error_message === undefined
          ? undefined
          : requireString(envelope.payload, "error_message", true);
      if (status === "error" && errorMessage === undefined) {
        throw new Error("An errored LLM stream requires error_message.");
      }
      if (status !== "error" && errorMessage !== undefined) {
        throw new Error("Only an errored LLM stream may include error_message.");
      }
      return {
        protocol_version: LLM_WORKER_PROTOCOL_VERSION,
        event_id: eventId,
        stream_id: requireIdentifier(envelope.stream_id, "stream_id"),
        type: "stream_finished",
        payload: {
          status,
          ...(errorMessage === undefined
            ? {}
            : { error_message: errorMessage }),
        },
      };
    }
    case "models_result":
      return {
        protocol_version: LLM_WORKER_PROTOCOL_VERSION,
        event_id: eventId,
        request_id: requireIdentifier(envelope.request_id, "request_id"),
        type: "models_result",
        payload: {
          provider_id: requireIdentifier(
            envelope.payload.provider_id,
            "provider_id",
          ),
          models: parseModelDescriptors(envelope.payload.models),
        },
      };
    case "models_error":
      return {
        protocol_version: LLM_WORKER_PROTOCOL_VERSION,
        event_id: eventId,
        request_id: requireIdentifier(envelope.request_id, "request_id"),
        type: "models_error",
        payload: {
          provider_id: requireIdentifier(
            envelope.payload.provider_id,
            "provider_id",
          ),
          error_message: requireNonEmptyString(
            envelope.payload.error_message,
            "error_message",
          ),
        },
      };
    case "protocol_error":
      if (envelope.payload.code !== "invalid_llm_command") {
        throw new Error("Invalid LLM protocol error code.");
      }
      return {
        protocol_version: LLM_WORKER_PROTOCOL_VERSION,
        event_id: eventId,
        type: "protocol_error",
        payload: {
          code: "invalid_llm_command",
          message: requireString(envelope.payload, "message"),
        },
      };
    default:
      throw new Error(`Unknown LLM worker event: ${String(envelope.type)}`);
  }
}

export function readLlmStreamId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.stream_id === "string" && value.stream_id.length > 0
    ? value.stream_id
    : undefined;
}

export function readLlmRequestId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.request_id === "string" && value.request_id.length > 0
    ? value.request_id
    : undefined;
}

function parseEnvelope(
  value: unknown,
  label: string,
): Record<string, unknown> & { payload: Record<string, unknown> } {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.protocol_version !== LLM_WORKER_PROTOCOL_VERSION) {
    throw new Error("Unsupported LLM worker protocol version.");
  }
  if (typeof value.type !== "string" || !isRecord(value.payload)) {
    throw new Error(`${label} type and payload are required.`);
  }
  return value as Record<string, unknown> & {
    payload: Record<string, unknown>;
  };
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
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
    throw new Error(`${field} must be a string.`);
  }
  return candidate;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
