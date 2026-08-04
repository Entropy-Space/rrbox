mod commands;
#[cfg(not(feature = "storage-test-harness"))]
mod protocol;
#[cfg(feature = "storage-test-harness")]
pub mod protocol;
mod provider;
mod python;
#[cfg(not(feature = "storage-test-harness"))]
mod storage;
#[cfg(feature = "storage-test-harness")]
pub mod storage;
mod web_search;

use commands::native_storage_request;
use provider::{
  ProviderService, native_provider_cancel, native_provider_fetch, native_provider_settings_list,
  native_provider_settings_remove, native_provider_settings_save, native_provider_settings_test,
};
use python::{PythonService, native_python_cancel, native_python_execute};
use storage::StorageService;
use tauri::Manager;
use web_search::{WebSearchService, native_web_search_cancel, native_web_search_execute};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      let storage_root = app.path().app_data_dir()?.join("researchbox");
      app.manage(StorageService::new(storage_root.clone())?);
      app.manage(ProviderService::new(storage_root)?);
      app.manage(PythonService::new());
      app.manage(WebSearchService::new()?);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      native_storage_request,
      native_provider_fetch,
      native_provider_cancel,
      native_provider_settings_list,
      native_provider_settings_save,
      native_provider_settings_remove,
      native_provider_settings_test,
      native_python_execute,
      native_python_cancel,
      native_web_search_execute,
      native_web_search_cancel,
    ])
    .run(tauri::generate_context!())
    .expect("rrbox native runtime failed");
}
