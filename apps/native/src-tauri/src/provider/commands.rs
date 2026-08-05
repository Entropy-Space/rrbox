use tauri::{State, ipc::Channel};

use super::{
  protocol::{
    NativeProviderBodyEvent, NativeProviderCancelRequest, NativeProviderFetchRequest,
    NativeProviderResponse,
  },
  service::ProviderService,
  settings::{ProviderConfigurationInput, ProviderSettingsSnapshot, ProviderTestResult},
};

#[tauri::command]
pub async fn native_provider_settings_list(
  provider: State<'_, ProviderService>,
) -> Result<ProviderSettingsSnapshot, String> {
  provider
    .settings_snapshot()
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn native_provider_settings_save(
  provider: State<'_, ProviderService>,
  input: ProviderConfigurationInput,
) -> Result<ProviderSettingsSnapshot, String> {
  let service = provider.inner().clone();
  tauri::async_runtime::spawn_blocking(move || service.save_settings(input))
    .await
    .map_err(|error| format!("Native provider settings worker failed: {error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn native_provider_settings_remove(
  provider: State<'_, ProviderService>,
  provider_id: String,
) -> Result<ProviderSettingsSnapshot, String> {
  let service = provider.inner().clone();
  tauri::async_runtime::spawn_blocking(move || service.remove_settings(&provider_id))
    .await
    .map_err(|error| format!("Native provider settings worker failed: {error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn native_provider_settings_test(
  provider: State<'_, ProviderService>,
  input: ProviderConfigurationInput,
) -> Result<ProviderTestResult, String> {
  provider
    .test_settings(input)
    .await
    .map_err(|error| error.to_string())
}

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
