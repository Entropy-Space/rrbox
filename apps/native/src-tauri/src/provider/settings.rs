use std::{
  collections::HashSet,
  fs::{self, File, OpenOptions},
  io::Write,
  path::{Path, PathBuf},
  sync::{Mutex, MutexGuard},
};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const PROVIDER_SETTINGS_FORMAT_VERSION: u32 = 1;
const MAX_PROVIDER_ID_BYTES: usize = 128;
const MAX_DISPLAY_NAME_BYTES: usize = 256;
const MAX_BASE_URL_BYTES: usize = 2_048;
const MAX_API_KEY_BYTES: usize = 16 * 1024;
const MAX_MANUAL_MODELS: usize = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderModelConfiguration {
  pub model_id: String,
  pub display_name: String,
  pub context_window: Option<u64>,
  pub max_output_tokens: Option<u64>,
  pub supports_tools: bool,
  pub supports_reasoning: bool,
  pub reasoning_efforts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfiguration {
  pub provider_id: String,
  pub display_name: String,
  pub preset_id: String,
  pub base_url: String,
  pub enabled: bool,
  pub manual_models: Vec<ProviderModelConfiguration>,
  pub send_reasoning_content: bool,
  pub send_session_affinity_headers: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfigurationInput {
  pub provider_id: String,
  pub display_name: String,
  pub preset_id: String,
  pub base_url: String,
  pub enabled: bool,
  pub manual_models: Vec<ProviderModelConfiguration>,
  pub send_reasoning_content: bool,
  pub send_session_affinity_headers: bool,
  #[serde(default)]
  pub api_key: Option<String>,
  #[serde(default)]
  pub remove_api_key: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderPublicConfiguration {
  pub provider_id: String,
  pub display_name: String,
  pub preset_id: String,
  pub base_url: String,
  pub enabled: bool,
  pub manual_models: Vec<ProviderModelConfiguration>,
  pub send_reasoning_content: bool,
  pub send_session_affinity_headers: bool,
  pub has_api_key: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderSettingsSnapshot {
  pub providers: Vec<ProviderPublicConfiguration>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderTestResult {
  pub model_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderSettingsDocument {
  format_version: u32,
  providers: Vec<ProviderConfiguration>,
}

pub struct ProviderSettingsStore {
  path: Option<PathBuf>,
  document: Mutex<ProviderSettingsDocument>,
}

#[derive(Debug, Error)]
pub enum ProviderSettingsError {
  #[error("{0}")]
  Invalid(String),
  #[error("{0}")]
  Internal(String),
}

impl ProviderSettingsStore {
  pub fn load(root: PathBuf) -> Result<Self, ProviderSettingsError> {
    let path = root.join("providers.json");
    let document = if path.exists() {
      let serialized = fs::read_to_string(&path).map_err(internal_io)?;
      let document: ProviderSettingsDocument =
        serde_json::from_str(&serialized).map_err(|error| {
          ProviderSettingsError::Internal(format!(
            "The native provider settings are malformed: {error}"
          ))
        })?;
      validate_document(document)?
    } else {
      default_document()
    };
    Ok(Self {
      path: Some(path),
      document: Mutex::new(document),
    })
  }

  #[cfg(test)]
  pub fn in_memory(base_url: String) -> Self {
    let mut document = default_document();
    document.providers[0].base_url = base_url;
    Self {
      path: None,
      document: Mutex::new(document),
    }
  }

  pub fn snapshot(&self) -> Result<ProviderSettingsSnapshot, ProviderSettingsError> {
    let document = self.lock()?;
    Ok(snapshot(&document))
  }

  pub fn resolve(
    &self,
    provider_id: &str,
  ) -> Result<Option<ProviderConfiguration>, ProviderSettingsError> {
    Ok(
      self
        .lock()?
        .providers
        .iter()
        .find(|provider| provider.provider_id == provider_id && provider.enabled)
        .cloned(),
    )
  }

  pub fn resolve_input(
    &self,
    input: ProviderConfigurationInput,
  ) -> Result<ProviderConfiguration, ProviderSettingsError> {
    let document = self.lock()?;
    normalize_input(input, &document)
  }

  pub fn save(
    &self,
    input: ProviderConfigurationInput,
  ) -> Result<ProviderSettingsSnapshot, ProviderSettingsError> {
    let mut document = self.lock()?;
    let provider = normalize_input(input, &document)?;
    let mut next = document.clone();
    if let Some(existing) = next
      .providers
      .iter_mut()
      .find(|candidate| candidate.provider_id == provider.provider_id)
    {
      *existing = provider;
    } else {
      next.providers.push(provider);
    }
    let next = validate_document(next)?;
    self.persist(&next)?;
    *document = next;
    Ok(snapshot(&document))
  }

  pub fn remove(
    &self,
    provider_id: &str,
  ) -> Result<ProviderSettingsSnapshot, ProviderSettingsError> {
    validate_provider_id(provider_id)?;
    let mut document = self.lock()?;
    let mut next = document.clone();
    next
      .providers
      .retain(|provider| provider.provider_id != provider_id);
    self.persist(&next)?;
    *document = next;
    Ok(snapshot(&document))
  }

  fn lock(&self) -> Result<MutexGuard<'_, ProviderSettingsDocument>, ProviderSettingsError> {
    self.document.lock().map_err(|_| {
      ProviderSettingsError::Internal("The provider settings lock was poisoned.".into())
    })
  }

  fn persist(&self, document: &ProviderSettingsDocument) -> Result<(), ProviderSettingsError> {
    let Some(path) = &self.path else {
      return Ok(());
    };
    let parent = path.parent().ok_or_else(|| {
      ProviderSettingsError::Internal("The provider settings path has no parent.".into())
    })?;
    fs::create_dir_all(parent).map_err(internal_io)?;
    let staged = parent.join(format!("providers-{}.tmp", Uuid::new_v4().simple()));
    let serialized = serde_json::to_vec_pretty(document).map_err(|error| {
      ProviderSettingsError::Internal(format!(
        "Could not serialize native provider settings: {error}"
      ))
    })?;
    let write_result = write_private_file(&staged, &serialized)
      .and_then(|()| fs::rename(&staged, path).map_err(internal_io))
      .and_then(|()| sync_directory(parent));
    if write_result.is_err() {
      let _ = fs::remove_file(&staged);
    }
    write_result
  }
}

fn default_document() -> ProviderSettingsDocument {
  ProviderSettingsDocument {
    format_version: PROVIDER_SETTINGS_FORMAT_VERSION,
    providers: vec![ProviderConfiguration {
      provider_id: "local-openai".into(),
      display_name: "OpenAI-compatible · localhost:4141".into(),
      preset_id: "local".into(),
      base_url: "http://127.0.0.1:4141/v1".into(),
      enabled: true,
      manual_models: Vec::new(),
      send_reasoning_content: true,
      send_session_affinity_headers: true,
      api_key: None,
    }],
  }
}

fn validate_document(
  mut document: ProviderSettingsDocument,
) -> Result<ProviderSettingsDocument, ProviderSettingsError> {
  if document.format_version != PROVIDER_SETTINGS_FORMAT_VERSION {
    return Err(ProviderSettingsError::Internal(format!(
      "Unsupported native provider settings format version: {}.",
      document.format_version
    )));
  }
  let mut provider_ids = HashSet::new();
  for provider in &mut document.providers {
    validate_provider(provider)?;
    if !provider_ids.insert(provider.provider_id.clone()) {
      return Err(ProviderSettingsError::Internal(format!(
        "Duplicate native provider_id: {}.",
        provider.provider_id
      )));
    }
  }
  Ok(document)
}

fn normalize_input(
  input: ProviderConfigurationInput,
  document: &ProviderSettingsDocument,
) -> Result<ProviderConfiguration, ProviderSettingsError> {
  if input.api_key.is_some() && input.remove_api_key {
    return Err(ProviderSettingsError::Invalid(
      "A provider API key cannot be set and removed together.".into(),
    ));
  }
  let existing_key = document
    .providers
    .iter()
    .find(|provider| provider.provider_id == input.provider_id)
    .and_then(|provider| provider.api_key.clone());
  let mut provider = ProviderConfiguration {
    provider_id: input.provider_id,
    display_name: input.display_name,
    preset_id: input.preset_id,
    base_url: input.base_url,
    enabled: input.enabled,
    manual_models: input.manual_models,
    send_reasoning_content: input.send_reasoning_content,
    send_session_affinity_headers: input.send_session_affinity_headers,
    api_key: if input.remove_api_key {
      None
    } else {
      input.api_key.or(existing_key)
    },
  };
  validate_provider(&mut provider)?;
  Ok(provider)
}

fn validate_provider(provider: &mut ProviderConfiguration) -> Result<(), ProviderSettingsError> {
  validate_provider_id(&provider.provider_id)?;
  provider.display_name = provider.display_name.trim().to_owned();
  if provider.display_name.is_empty() || provider.display_name.len() > MAX_DISPLAY_NAME_BYTES {
    return Err(ProviderSettingsError::Invalid(format!(
      "display_name must contain 1 to {MAX_DISPLAY_NAME_BYTES} bytes."
    )));
  }
  if !matches!(
    provider.preset_id.as_str(),
    "local" | "openai" | "openrouter" | "deepseek" | "groq" | "together" | "custom"
  ) {
    return Err(ProviderSettingsError::Invalid(
      "Invalid provider preset_id.".into(),
    ));
  }
  provider.base_url = normalize_base_url(&provider.base_url)?;
  if provider.manual_models.len() > MAX_MANUAL_MODELS {
    return Err(ProviderSettingsError::Invalid(format!(
      "manual_models must contain at most {MAX_MANUAL_MODELS} entries."
    )));
  }
  let mut model_ids = HashSet::new();
  for model in &mut provider.manual_models {
    validate_model(model)?;
    if !model_ids.insert(model.model_id.clone()) {
      return Err(ProviderSettingsError::Invalid(format!(
        "Duplicate provider model_id: {}.",
        model.model_id
      )));
    }
  }
  if let Some(api_key) = &provider.api_key
    && (api_key.is_empty() || api_key.len() > MAX_API_KEY_BYTES || api_key.contains(['\r', '\n']))
  {
    return Err(ProviderSettingsError::Invalid(format!(
      "api_key must contain 1 to {MAX_API_KEY_BYTES} bytes without line breaks."
    )));
  }
  Ok(())
}

fn validate_model(model: &mut ProviderModelConfiguration) -> Result<(), ProviderSettingsError> {
  model.model_id = model.model_id.trim().to_owned();
  model.display_name = model.display_name.trim().to_owned();
  if model.model_id.is_empty() || model.model_id.len() > MAX_DISPLAY_NAME_BYTES {
    return Err(ProviderSettingsError::Invalid(
      "model_id must contain 1 to 256 bytes.".into(),
    ));
  }
  if model.display_name.is_empty() || model.display_name.len() > MAX_DISPLAY_NAME_BYTES {
    return Err(ProviderSettingsError::Invalid(
      "Model display_name must contain 1 to 256 bytes.".into(),
    ));
  }
  let mut efforts = HashSet::new();
  for effort in &model.reasoning_efforts {
    if !matches!(
      effort.as_str(),
      "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    ) {
      return Err(ProviderSettingsError::Invalid(
        "Invalid provider model reasoning effort.".into(),
      ));
    }
    if !efforts.insert(effort) {
      return Err(ProviderSettingsError::Invalid(
        "Provider model reasoning efforts must be unique.".into(),
      ));
    }
  }
  if !model.supports_reasoning && !model.reasoning_efforts.is_empty() {
    return Err(ProviderSettingsError::Invalid(
      "A non-reasoning provider model cannot define reasoning efforts.".into(),
    ));
  }
  if model.context_window == Some(0) || model.max_output_tokens == Some(0) {
    return Err(ProviderSettingsError::Invalid(
      "Provider model limits must be positive integers or null.".into(),
    ));
  }
  Ok(())
}

fn validate_provider_id(provider_id: &str) -> Result<(), ProviderSettingsError> {
  let valid = !provider_id.is_empty()
    && provider_id.len() <= MAX_PROVIDER_ID_BYTES
    && provider_id.bytes().enumerate().all(|(index, byte)| {
      byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
    });
  if !valid {
    return Err(ProviderSettingsError::Invalid(
      "provider_id must be a valid non-empty identifier.".into(),
    ));
  }
  if provider_id == "researchbox" {
    return Err(ProviderSettingsError::Invalid(
      "provider_id is reserved: researchbox.".into(),
    ));
  }
  Ok(())
}

fn normalize_base_url(value: &str) -> Result<String, ProviderSettingsError> {
  let candidate = value.trim();
  if candidate.is_empty() || candidate.len() > MAX_BASE_URL_BYTES {
    return Err(ProviderSettingsError::Invalid(
      "base_url must contain 1 to 2048 bytes.".into(),
    ));
  }
  let mut url = Url::parse(candidate)
    .map_err(|_| ProviderSettingsError::Invalid("base_url must be a valid URL.".into()))?;
  if url.scheme() != "https" && url.scheme() != "http" {
    return Err(ProviderSettingsError::Invalid(
      "base_url must use http or https.".into(),
    ));
  }
  if !url.username().is_empty()
    || url.password().is_some()
    || url.query().is_some()
    || url.fragment().is_some()
  {
    return Err(ProviderSettingsError::Invalid(
      "base_url cannot contain credentials, a query, or a fragment.".into(),
    ));
  }
  let normalized_path = url.path().trim_end_matches('/').to_owned();
  url.set_path(&normalized_path);
  Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn snapshot(document: &ProviderSettingsDocument) -> ProviderSettingsSnapshot {
  ProviderSettingsSnapshot {
    providers: document
      .providers
      .iter()
      .map(|provider| ProviderPublicConfiguration {
        provider_id: provider.provider_id.clone(),
        display_name: provider.display_name.clone(),
        preset_id: provider.preset_id.clone(),
        base_url: provider.base_url.clone(),
        enabled: provider.enabled,
        manual_models: provider.manual_models.clone(),
        send_reasoning_content: provider.send_reasoning_content,
        send_session_affinity_headers: provider.send_session_affinity_headers,
        has_api_key: provider.api_key.is_some(),
      })
      .collect(),
  }
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), ProviderSettingsError> {
  let mut options = OpenOptions::new();
  options.create_new(true).write(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(path).map_err(internal_io)?;
  file.write_all(contents).map_err(internal_io)?;
  file.sync_all().map_err(internal_io)
}

fn sync_directory(path: &Path) -> Result<(), ProviderSettingsError> {
  #[cfg(unix)]
  File::open(path)
    .and_then(|directory| directory.sync_all())
    .map_err(internal_io)?;
  #[cfg(not(unix))]
  let _ = path;
  Ok(())
}

fn internal_io(error: std::io::Error) -> ProviderSettingsError {
  ProviderSettingsError::Internal(format!("Native provider settings I/O failed: {error}"))
}

#[cfg(test)]
mod tests {
  use super::{ProviderConfigurationInput, ProviderSettingsStore};

  #[test]
  fn saved_snapshots_mask_api_keys_and_preserve_them_on_empty_edits() {
    let store = ProviderSettingsStore::in_memory("http://127.0.0.1:1/v1".into());
    let input = ProviderConfigurationInput {
      provider_id: "provider-1".into(),
      display_name: "Provider".into(),
      preset_id: "custom".into(),
      base_url: "https://example.com/v1".into(),
      enabled: true,
      manual_models: Vec::new(),
      send_reasoning_content: false,
      send_session_affinity_headers: false,
      api_key: Some("secret".into()),
      remove_api_key: false,
    };
    let snapshot = store.save(input).expect("save provider");
    assert!(snapshot.providers.last().expect("provider").has_api_key);

    let saved = store
      .resolve("provider-1")
      .expect("resolve")
      .expect("provider");
    assert_eq!(saved.api_key.as_deref(), Some("secret"));
  }

  #[test]
  fn disk_settings_persist_keys_privately_without_returning_them() {
    let directory = tempfile::tempdir().expect("temporary provider directory");
    let store =
      ProviderSettingsStore::load(directory.path().into()).expect("load provider settings");
    store
      .save(ProviderConfigurationInput {
        provider_id: "provider-1".into(),
        display_name: "Provider".into(),
        preset_id: "custom".into(),
        base_url: "https://example.com/v1".into(),
        enabled: true,
        manual_models: Vec::new(),
        send_reasoning_content: false,
        send_session_affinity_headers: false,
        api_key: Some("secret".into()),
        remove_api_key: false,
      })
      .expect("save provider settings");

    let path = directory.path().join("providers.json");
    let serialized = std::fs::read_to_string(&path).expect("read saved settings");
    assert!(serialized.contains("secret"));
    #[cfg(unix)]
    assert_eq!(
      std::os::unix::fs::MetadataExt::mode(&std::fs::metadata(&path).expect("settings metadata"),)
        & 0o077,
      0
    );

    let reloaded =
      ProviderSettingsStore::load(directory.path().into()).expect("reload provider settings");
    let snapshot = reloaded.snapshot().expect("public snapshot");
    assert!(
      snapshot
        .providers
        .iter()
        .any(|provider| { provider.provider_id == "provider-1" && provider.has_api_key })
    );
    assert_eq!(
      reloaded
        .resolve("provider-1")
        .expect("resolve provider")
        .expect("saved provider")
        .api_key
        .as_deref(),
      Some("secret")
    );
  }
}
