export const NATIVE_PROVIDER_PROTOCOL_VERSION = 3 as const;
export const NATIVE_OPENAI_PROVIDER_ID = "local-openai" as const;

export type NativeProviderSessionAffinityHeaderName =
  | "session_id"
  | "x-client-request-id"
  | "x-session-affinity";

export type NativeProviderSessionAffinityHeaders = Partial<
  Record<NativeProviderSessionAffinityHeaderName, string>
>;

export type NativeProviderEndpoint = "models" | "chat_completions";
export type NativeProviderMethod = "get" | "post";

export type NativeProviderFetchRequest = {
  protocol_version: typeof NATIVE_PROVIDER_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
  provider_id: string;
  endpoint: NativeProviderEndpoint;
  method: NativeProviderMethod;
  body?: string;
  session_affinity_headers?: NativeProviderSessionAffinityHeaders;
};

export type NativeProviderCancelRequest = {
  protocol_version: typeof NATIVE_PROVIDER_PROTOCOL_VERSION;
  request_id: string;
  operation_id: string;
};

export type NativeProviderRequest =
  | NativeProviderFetchRequest
  | NativeProviderCancelRequest;

export type NativeProviderErrorCode =
  | "invalid_request"
  | "provider_unavailable"
  | "provider_response_too_large"
  | "internal";

export type NativeProviderError = {
  code: NativeProviderErrorCode;
  message: string;
};

export type NativeProviderErrorResult = {
  kind: "error";
  error: NativeProviderError;
};

export type NativeProviderFetchStartedResult = {
  kind: "fetch_started";
  operation_id: string;
};

export type NativeProviderOperationCancelledResult = {
  kind: "operation_cancelled";
  operation_id: string;
  was_active: boolean;
};

export type NativeProviderFetchResponse = {
  protocol_version: typeof NATIVE_PROVIDER_PROTOCOL_VERSION;
  request_id: string;
  result: NativeProviderFetchStartedResult | NativeProviderErrorResult;
};

export type NativeProviderCancelResponse = {
  protocol_version: typeof NATIVE_PROVIDER_PROTOCOL_VERSION;
  request_id: string;
  result:
    | NativeProviderOperationCancelledResult
    | NativeProviderErrorResult;
};

export type NativeProviderResponse =
  | NativeProviderFetchResponse
  | NativeProviderCancelResponse;

type NativeProviderBodyEventEnvelope<TKind extends string> = {
  protocol_version: typeof NATIVE_PROVIDER_PROTOCOL_VERSION;
  operation_id: string;
  event_index: number;
  kind: TKind;
};

export type NativeProviderResponseStartedEvent =
  NativeProviderBodyEventEnvelope<"response_started"> & {
    status: number;
    status_text: string;
    headers: Record<string, string>;
  };

export type NativeProviderBodyChunkEvent =
  NativeProviderBodyEventEnvelope<"body_chunk"> & {
    chunk_base64: string;
  };

export type NativeProviderBodyFinishedEvent =
  NativeProviderBodyEventEnvelope<"body_finished"> & {
    status: "complete" | "aborted" | "error";
    error_message?: string;
  };

export type NativeProviderBodyEvent =
  | NativeProviderResponseStartedEvent
  | NativeProviderBodyChunkEvent
  | NativeProviderBodyFinishedEvent;

export type NativeProviderConnectionError = {
  protocol_version: typeof NATIVE_PROVIDER_PROTOCOL_VERSION;
  kind: "connection_error";
  error_message: string;
};

export type NativeProviderBrokerMessage =
  | NativeProviderResponse
  | NativeProviderBodyEvent
  | NativeProviderConnectionError;
