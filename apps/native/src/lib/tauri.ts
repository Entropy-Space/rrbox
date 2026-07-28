import { Channel, invoke } from "@tauri-apps/api/core";
import {
  parseNativeProviderCancelResponse,
  parseNativeProviderFetchResponse,
  type NativeProviderCancelRequest,
  type NativeProviderCancelResponse,
  type NativeProviderFetchRequest,
  type NativeProviderFetchResponse,
} from "@researchbox/provider-native";
import {
  parseNativeStorageResponse,
  type NativeStorageRequest,
  type NativeStorageResponse,
} from "@researchbox/storage-native";
import {
  parsePythonCancelResponse,
  parsePythonExecuteResponse,
  type PythonCancelRequest,
  type PythonCancelResponse,
  type PythonExecuteRequest,
  type PythonExecuteResponse,
} from "@researchbox/python-plugin/protocol";
import {
  parseNativeWebSearchResponse,
  type NativeWebSearchCancelRequest,
  type NativeWebSearchCancelResponse,
  type NativeWebSearchExecuteRequest,
  type NativeWebSearchExecuteResponse,
} from "@researchbox/web-search-plugin/native-protocol";

const NATIVE_STORAGE_COMMAND = "native_storage_request";
const NATIVE_PROVIDER_FETCH_COMMAND = "native_provider_fetch";
const NATIVE_PROVIDER_CANCEL_COMMAND = "native_provider_cancel";
const NATIVE_PYTHON_EXECUTE_COMMAND = "native_python_execute";
const NATIVE_PYTHON_CANCEL_COMMAND = "native_python_cancel";
const NATIVE_WEB_SEARCH_EXECUTE_COMMAND = "native_web_search_execute";
const NATIVE_WEB_SEARCH_CANCEL_COMMAND = "native_web_search_cancel";

export async function invokeNativeStorageRequest(
  request: NativeStorageRequest,
): Promise<NativeStorageResponse> {
  const response = parseNativeStorageResponse(
    await invoke<unknown>(NATIVE_STORAGE_COMMAND, { request }),
  );
  if (response.request_id !== request.request_id) {
    throw new Error(
      "Native storage returned a response for a different request.",
    );
  }
  return response;
}

export async function invokeNativeProviderFetch(
  request: NativeProviderFetchRequest,
  onEvent: (event: unknown) => void,
): Promise<NativeProviderFetchResponse> {
  const onEventChannel = new Channel<unknown>(onEvent);
  const response = parseNativeProviderFetchResponse(
    await invoke<unknown>(NATIVE_PROVIDER_FETCH_COMMAND, {
      request,
      on_event: onEventChannel,
    }),
  );
  assertMatchingRequestId(response.request_id, request.request_id);
  return response;
}

export async function invokeNativeProviderCancel(
  request: NativeProviderCancelRequest,
): Promise<NativeProviderCancelResponse> {
  const response = parseNativeProviderCancelResponse(
    await invoke<unknown>(NATIVE_PROVIDER_CANCEL_COMMAND, { request }),
  );
  assertMatchingRequestId(response.request_id, request.request_id);
  return response;
}

export const nativeProviderCommands = {
  fetch: invokeNativeProviderFetch,
  cancel: invokeNativeProviderCancel,
};

export async function invokeNativePythonExecute(
  request: PythonExecuteRequest,
): Promise<PythonExecuteResponse> {
  const response = parsePythonExecuteResponse(
    await invoke<unknown>(NATIVE_PYTHON_EXECUTE_COMMAND, { request }),
  );
  assertMatchingRequestId(response.request_id, request.request_id);
  return response;
}

export async function invokeNativePythonCancel(
  request: PythonCancelRequest,
): Promise<PythonCancelResponse> {
  const response = parsePythonCancelResponse(
    await invoke<unknown>(NATIVE_PYTHON_CANCEL_COMMAND, { request }),
  );
  assertMatchingRequestId(response.request_id, request.request_id);
  return response;
}

export const nativePythonCommands = {
  execute: invokeNativePythonExecute,
  cancel: invokeNativePythonCancel,
};

export async function invokeNativeWebSearchExecute(
  request: NativeWebSearchExecuteRequest,
): Promise<NativeWebSearchExecuteResponse> {
  const response = parseNativeWebSearchResponse(
    await invoke<unknown>(NATIVE_WEB_SEARCH_EXECUTE_COMMAND, {
      request,
    }),
  );
  assertMatchingRequestId(response.request_id, request.request_id);
  if (response.kind !== "web_search_execute_result") {
    throw new Error("Native web search returned the wrong response.");
  }
  return response;
}

export async function invokeNativeWebSearchCancel(
  request: NativeWebSearchCancelRequest,
): Promise<NativeWebSearchCancelResponse> {
  const response = parseNativeWebSearchResponse(
    await invoke<unknown>(NATIVE_WEB_SEARCH_CANCEL_COMMAND, {
      request,
    }),
  );
  assertMatchingRequestId(response.request_id, request.request_id);
  if (response.kind !== "web_search_cancel_result") {
    throw new Error("Native web search returned the wrong response.");
  }
  return response;
}

export const nativeWebSearchCommands = {
  execute: invokeNativeWebSearchExecute,
  cancel: invokeNativeWebSearchCancel,
};

function assertMatchingRequestId(
  responseRequestId: string,
  requestRequestId: string,
): void {
  if (responseRequestId !== requestRequestId) {
    throw new Error(
      "Native provider returned a response for a different request.",
    );
  }
}
