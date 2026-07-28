mod commands;
#[cfg(not(feature = "storage-test-harness"))]
mod protocol;
#[cfg(feature = "storage-test-harness")]
pub mod protocol;
mod provider;
#[cfg(not(feature = "storage-test-harness"))]
mod storage;
#[cfg(feature = "storage-test-harness")]
pub mod storage;

use commands::native_storage_request;
use provider::{ProviderService, native_provider_cancel, native_provider_fetch};
use storage::StorageService;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      let storage_root = app.path().app_data_dir()?.join("researchbox");
      app.manage(StorageService::new(storage_root)?);
      app.manage(ProviderService::new()?);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      native_storage_request,
      native_provider_fetch,
      native_provider_cancel,
    ])
    .run(tauri::generate_context!())
    .expect("ResearchBox native runtime failed");
}
