use std::{
  collections::BTreeMap,
  fs,
  io::Write,
  path::PathBuf,
  sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use tokn_sdk::Client;

use super::settings::{ProviderConfiguration, ProviderPublicConfiguration, UpstreamProvider};

#[path = "tokn_models.rs"]
mod catalog;
#[path = "tokn_setup.rs"]
mod setup;
pub use setup::{ToknAccountSummary, ToknConnectInput, ToknSetupProvider};

pub const PROVIDER_ID: &str = "builtin:tokn";
const MAX_CONFIG_BYTES: usize = 256 * 1024;
const DEFAULT_CONFIG: &str = "[defaults]\nmode = \"exact\"\n";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
  format_version: u32,
  enabled: bool,
  config_toml: String,
  credentials_yaml: String,
  model_ids: Vec<String>,
  /// Only accounts created by guided setup can have their key replaced there.
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  setup_accounts: BTreeMap<String, String>,
}

impl Default for Document {
  fn default() -> Self {
    Self {
      format_version: 1,
      enabled: false,
      config_toml: DEFAULT_CONFIG.into(),
      credentials_yaml: String::new(),
      model_ids: Vec::new(),
      setup_accounts: BTreeMap::new(),
    }
  }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToknSettingsInput {
  pub enabled: bool,
  pub config_toml: String,
  pub model_ids: Vec<String>,
  pub credentials_yaml: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToknSettingsSnapshot {
  pub enabled: bool,
  pub config_toml: String,
  pub model_ids: Vec<String>,
  pub has_credentials: bool,
  pub status: &'static str,
  pub setup_providers: Vec<ToknSetupProvider>,
  pub accounts: Vec<ToknAccountSummary>,
}

pub struct EmbeddedClient {
  pub client: Client,
  // Drop the client before removing its isolated config/auth files.
  _directory: TempDir,
}

struct State {
  document: Document,
  client: Option<Arc<EmbeddedClient>>,
}

pub struct EmbeddedTokn {
  root: PathBuf,
  state: Mutex<State>,
}

impl EmbeddedTokn {
  pub fn new(root: PathBuf) -> Result<Self, String> {
    let path = root.join("embedded-tokn.json");
    let document = if path.exists() {
      let bytes = fs::read(path).map_err(|_| "Could not read embedded tokn settings.")?;
      let document: Document =
        serde_json::from_slice(&bytes).map_err(|_| "Embedded tokn settings are malformed.")?;
      if document.format_version != 1 {
        return Err("Unsupported embedded tokn settings version.".into());
      }
      document
    } else {
      Document::default()
    };
    Ok(Self {
      root,
      state: Mutex::new(State {
        document,
        client: None,
      }),
    })
  }

  pub fn snapshot(&self) -> Result<ToknSettingsSnapshot, String> {
    let state = self
      .state
      .lock()
      .map_err(|_| "Embedded tokn settings are unavailable.")?;
    let doc = &state.document;
    Ok(ToknSettingsSnapshot {
      enabled: doc.enabled,
      config_toml: doc.config_toml.clone(),
      model_ids: doc.model_ids.clone(),
      has_credentials: !doc.credentials_yaml.trim().is_empty(),
      setup_providers: setup::providers(),
      accounts: setup::account_summaries(doc),
      status: if doc.credentials_yaml.trim().is_empty() {
        "unconfigured"
      } else if !doc.enabled {
        "disabled"
      } else if state.client.is_some() {
        "ready"
      } else {
        "configured"
      },
    })
  }

  pub fn provider(&self) -> Result<ProviderConfiguration, String> {
    let snapshot = self.snapshot()?;
    Ok(ProviderConfiguration {
      provider_id: PROVIDER_ID.into(),
      display_name: "Tokn · embedded".into(),
      preset_id: "custom".into(),
      base_url: String::new(),
      enabled: snapshot.enabled,
      manual_models: Vec::new(),
      send_reasoning_content: true,
      send_session_affinity_headers: true,
      api_key: None,
    })
  }

  pub fn public_provider(&self) -> Result<ProviderPublicConfiguration, String> {
    let provider = self.provider()?;
    let upstream_providers = self
      .snapshot()?
      .accounts
      .into_iter()
      .filter(|account| account.enabled)
      .map(|account| (account.provider_id, account.display_name))
      .collect::<BTreeMap<_, _>>()
      .into_iter()
      .map(|(provider_id, display_name)| UpstreamProvider {
        provider_id,
        display_name,
      })
      .collect();
    Ok(ProviderPublicConfiguration {
      backend: Some("tokn".into()),
      upstream_providers: Some(upstream_providers),
      provider_id: provider.provider_id,
      display_name: provider.display_name,
      preset_id: provider.preset_id,
      base_url: provider.base_url,
      enabled: provider.enabled,
      manual_models: provider.manual_models,
      send_reasoning_content: true,
      send_session_affinity_headers: true,
      has_api_key: false,
    })
  }

  /// Candidate construction and persistence happen before replacing the live
  /// engine. In-flight requests retain their old Arc through completion.
  pub fn save(&self, input: ToknSettingsInput) -> Result<(), String> {
    let mut state = self
      .state
      .lock()
      .map_err(|_| "Embedded tokn settings are unavailable.")?;
    let document = normalize_input(input, &state.document)?;
    self.persist(&mut state, document)
  }

  pub fn connect(&self, input: ToknConnectInput) -> Result<(), String> {
    let mut state = self
      .state
      .lock()
      .map_err(|_| "Embedded tokn settings are unavailable.")?;
    let document = setup::connect(input, &state.document)?;
    self.persist(&mut state, document)
  }

  fn persist(&self, state: &mut State, document: Document) -> Result<(), String> {
    let client = if document.credentials_yaml.trim().is_empty() && !document.enabled {
      None
    } else {
      Some(Arc::new(self.build_client(&document)?))
    };
    fs::create_dir_all(&self.root).map_err(|_| "Could not create provider storage.")?;
    let mut staged = tempfile::NamedTempFile::new_in(&self.root)
      .map_err(|_| "Could not stage embedded tokn settings.")?;
    serde_json::to_writer(staged.as_file_mut(), &document)
      .map_err(|_| "Could not serialize embedded tokn settings.")?;
    staged
      .as_file()
      .sync_all()
      .map_err(|_| "Could not sync embedded tokn settings.")?;
    staged
      .persist(self.root.join("embedded-tokn.json"))
      .map_err(|_| "Could not save embedded tokn settings.")?;
    state.document = document;
    state.client = client;
    Ok(())
  }

  pub fn validate(&self, input: ToknSettingsInput) -> Result<(), String> {
    let state = self
      .state
      .lock()
      .map_err(|_| "Embedded tokn settings are unavailable.")?;
    let document = normalize_input(input, &state.document)?;
    self.build_client(&document).map(drop)
  }

  pub fn reload(&self) -> Result<(), String> {
    let mut state = self
      .state
      .lock()
      .map_err(|_| "Embedded tokn settings are unavailable.")?;
    let client = Arc::new(self.build_client(&state.document)?);
    state.client = Some(client);
    Ok(())
  }

  pub fn client(&self) -> Result<Arc<EmbeddedClient>, String> {
    let mut state = self
      .state
      .lock()
      .map_err(|_| "Embedded tokn settings are unavailable.")?;
    if !state.document.enabled {
      return Err("Embedded tokn is disabled.".into());
    }
    if let Some(client) = &state.client {
      return Ok(client.clone());
    }
    let client = Arc::new(self.build_client(&state.document)?);
    state.client = Some(client.clone());
    Ok(client)
  }

  pub fn models(&self) -> Result<serde_json::Value, String> {
    let snapshot = self.snapshot()?;
    if !snapshot.enabled {
      return Err("Embedded tokn is disabled.".into());
    }
    Ok(catalog::models(&snapshot))
  }

  fn build_client(&self, document: &Document) -> Result<EmbeddedClient, String> {
    let mut config = parse_routing_config(&document.config_toml)?;
    // rrbox owns conversation persistence. Never let the embedded library use
    // gateway-wide databases, agents, or credential paths on desktop.
    config.db.enabled = false;
    config.agents.clear();
    fs::create_dir_all(&self.root).map_err(|_| "Could not create provider storage.")?;
    let directory = tempfile::Builder::new()
      .prefix("tokn-runtime-")
      .tempdir_in(&self.root)
      .map_err(|_| "Could not create isolated tokn configuration.")?;
    let config_path = directory.path().join("config.toml");
    let auth_path = directory.path().join("auth.yaml");
    let serialized =
      toml::to_string(&config).map_err(|_| "Could not serialize tokn routing configuration.")?;
    write_private(&config_path, serialized.as_bytes())?;
    write_private(&auth_path, document.credentials_yaml.as_bytes())?;
    // Errors from YAML/TOML parsers can contain secrets: do not forward them.
    let client = Client::builder()
      .config_path(config_path)
      .auth_path(auth_path)
      .build()
      .map_err(
        |_| "Tokn could not initialize. Check routing configuration and account credentials.",
      )?;
    Ok(EmbeddedClient {
      client,
      _directory: directory,
    })
  }
}

fn normalize_input(input: ToknSettingsInput, existing: &Document) -> Result<Document, String> {
  if input.config_toml.len() > MAX_CONFIG_BYTES {
    return Err("Tokn configuration is too large.".into());
  }
  parse_routing_config(&input.config_toml)?;
  // Explicit advanced credential replacement relinquishes guided ownership.
  // Never overwrite a manually edited/imported account on a later Connect.
  let setup_accounts = if input.credentials_yaml.is_some() {
    BTreeMap::new()
  } else {
    existing.setup_accounts.clone()
  };
  let credentials_yaml = input
    .credentials_yaml
    .unwrap_or_else(|| existing.credentials_yaml.clone());
  if credentials_yaml.len() > MAX_CONFIG_BYTES {
    return Err("Tokn credentials are too large.".into());
  }
  if input.enabled && credentials_yaml.trim().is_empty() {
    return Err("Add account credentials before enabling tokn.".into());
  }
  let mut model_ids = input
    .model_ids
    .iter()
    .map(|id| id.trim().to_string())
    .collect::<Vec<_>>();
  if model_ids.len() > 1000
    || model_ids
      .iter()
      .any(|id| id.is_empty() || id.len() > 256 || id.contains(['\r', '\n']))
  {
    return Err("Provide up to 1000 non-empty model selectors, each at most 256 bytes.".into());
  }
  model_ids.sort();
  model_ids.dedup();
  if input.enabled && model_ids.is_empty() {
    return Err("Add a model selector before enabling tokn.".into());
  }
  Ok(Document {
    format_version: 1,
    enabled: input.enabled,
    config_toml: input.config_toml,
    credentials_yaml,
    model_ids,
    setup_accounts,
  })
}

fn parse_routing_config(source: &str) -> Result<tokn_config::Config, String> {
  let value: toml::Table = toml::from_str(source).map_err(|_| "Invalid routing TOML.")?;
  if value.keys().any(|key| {
    !matches!(
      key.as_str(),
      "defaults" | "profiles" | "pool" | "model_families" | "proxy"
    )
  }) {
    return Err("Embedded routing accepts defaults, profiles, pool, model_families, and proxy only. Gateway listeners, databases, and linked agents are managed by rrbox.".into());
  }
  let config: tokn_config::Config =
    toml::from_str(source).map_err(|_| "Invalid routing configuration.")?;
  config
    .validate()
    .map_err(|_| "Invalid routing configuration: check modes, profiles, and rules.")?;
  Ok(config)
}

fn write_private(path: &std::path::Path, contents: &[u8]) -> Result<(), String> {
  let mut options = fs::OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options
    .open(path)
    .map_err(|_| "Could not create tokn configuration file.")?;
  file
    .write_all(contents)
    .map_err(|_| "Could not write tokn configuration file.".into())
}

#[cfg(test)]
#[path = "embedded_tokn_tests.rs"]
mod tests;
