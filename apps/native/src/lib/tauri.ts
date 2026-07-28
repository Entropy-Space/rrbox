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

const NATIVE_STORAGE_COMMAND = "native_storage_request";
const NATIVE_PROVIDER_FETCH_COMMAND = "native_provider_fetch";
const NATIVE_PROVIDER_CANCEL_COMMAND = "native_provider_cancel";

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
