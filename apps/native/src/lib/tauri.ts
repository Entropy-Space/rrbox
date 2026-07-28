import { invoke } from "@tauri-apps/api/core";
import {
  parseNativeStorageResponse,
  type NativeStorageRequest,
  type NativeStorageResponse,
} from "@researchbox/storage-native";

const NATIVE_STORAGE_COMMAND = "native_storage_request";

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
