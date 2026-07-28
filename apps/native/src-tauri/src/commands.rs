use tauri::State;

use crate::{
  protocol::{NATIVE_STORAGE_PROTOCOL_VERSION, NativeStorageRequest, NativeStorageResponse},
  storage::StorageService,
};

#[tauri::command]
pub async fn native_storage_request(
  storage: State<'_, StorageService>,
  request: NativeStorageRequest,
) -> Result<NativeStorageResponse, ()> {
  let request_id = request.request_id;
  if request.protocol_version != NATIVE_STORAGE_PROTOCOL_VERSION {
    return Ok(NativeStorageResponse::error(
      request_id,
      "invalid_request",
      format!(
        "Unsupported native storage protocol version: {}.",
        request.protocol_version
      ),
    ));
  }
  if request_id.is_empty() {
    return Ok(NativeStorageResponse::error(
      request_id,
      "invalid_request",
      "request_id must be a non-empty string.",
    ));
  }

  let service = storage.inner().clone();
  let outcome =
    tauri::async_runtime::spawn_blocking(move || service.execute(request.operation)).await;
  Ok(match outcome {
    Ok(Ok(result)) => NativeStorageResponse::new(request_id, result),
    Ok(Err(error)) => NativeStorageResponse::error(request_id, error.code(), error.to_string()),
    Err(error) => NativeStorageResponse::error(
      request_id,
      "internal",
      format!("Native storage worker failed: {error}"),
    ),
  })
}
