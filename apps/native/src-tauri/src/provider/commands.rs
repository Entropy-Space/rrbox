use tauri::{State, ipc::Channel};

use super::{
  protocol::{
    NativeProviderBodyEvent, NativeProviderCancelRequest, NativeProviderFetchRequest,
    NativeProviderResponse,
  },
  service::ProviderService,
};

#[tauri::command(rename_all = "snake_case")]
pub async fn native_provider_fetch(
  provider: State<'_, ProviderService>,
  request: NativeProviderFetchRequest,
  on_event: Channel<NativeProviderBodyEvent>,
) -> Result<NativeProviderResponse, ()> {
  let request_id = request.request_id.clone();
  let service = provider.inner().clone();
  Ok(
    match service.start_fetch(request, move |event| on_event.send(event).map_err(|_| ())) {
      Ok(operation_id) => NativeProviderResponse::fetch_started(request_id, operation_id),
      Err(error) => NativeProviderResponse::error(request_id, error.code(), error.to_string()),
    },
  )
}

#[tauri::command(rename_all = "snake_case")]
pub async fn native_provider_cancel(
  provider: State<'_, ProviderService>,
  request: NativeProviderCancelRequest,
) -> Result<NativeProviderResponse, ()> {
  let request_id = request.request_id.clone();
  let operation_id = request.operation_id.clone();
  Ok(match provider.cancel(&request) {
    Ok(was_active) => {
      NativeProviderResponse::operation_cancelled(request_id, operation_id, was_active)
    }
    Err(error) => NativeProviderResponse::error(request_id, error.code(), error.to_string()),
  })
}
