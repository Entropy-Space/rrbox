//! Guided setup owns only the accounts it creates. Routing, manual model
//! selectors, and imported accounts remain unchanged; secrets never leave Rust.
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use tokn_accounts::registry::Registry;

use super::{Document, ToknSettingsInput, normalize_input};

const PROVIDERS: &[&str] = &[
  "openai",
  "deepseek",
  "zai",
  "zai-coding-plan",
  "zhipuai",
  "zhipuai-coding-plan",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToknConnectInput {
  pub provider_id: String,
  pub api_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToknSetupProvider {
  pub provider_id: String,
  pub display_name: String,
  pub model_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToknAccountSummary {
  pub account_id: String,
  pub provider_id: String,
  pub display_name: String,
  pub enabled: bool,
  pub has_api_key: bool,
  pub managed: bool,
}

pub fn providers() -> Vec<ToknSetupProvider> {
  let registry = Registry::builtin();
  PROVIDERS
    .iter()
    .filter_map(|id| {
      let descriptor = registry.resolve(id)?;
      Some(ToknSetupProvider {
        provider_id: (*id).into(),
        display_name: descriptor.display_name.into(),
        model_count: model_ids(id).len(),
      })
    })
    .collect()
}

fn model_ids(provider_id: &str) -> Vec<String> {
  tokn_catalogue::default_models_for(provider_id).into_iter()
    .filter(|model| {
      model.capabilities.toolcall && model.capabilities.input.text && model.capabilities.output.text
        && !model.id.is_empty() && model.id.len() <= 200 && !model.id.contains(['\r', '\n'])
        // rrbox currently sends Chat Completions. Catalogue capabilities don't
        // encode endpoint support; omit known Responses-only OpenAI families.
        && (provider_id != "openai" || !["codex", "-pro", "deep-research"].iter().any(|part| model.id.contains(part)))
    })
    .map(|model| format!("{provider_id}/{}", model.id))
    .collect()
}

fn auth_document(source: &str) -> Result<Mapping, String> {
  let value: Value = if source.trim().is_empty() {
    serde_yaml::from_str("version: 1\naccounts: []\n").expect("static auth document")
  } else {
    serde_yaml::from_str(source)
      .map_err(|_| "Saved Tokn credentials could not be read. Review them in Advanced.")?
  };
  let mut root = value
    .as_mapping()
    .cloned()
    .ok_or("Saved Tokn credentials must be an account document. Review them in Advanced.")?;
  if root.get("version").is_some_and(|v| v.as_u64() != Some(1)) {
    return Err(
      "Unsupported Tokn credential format. Existing credentials were not changed.".into(),
    );
  }
  root
    .entry(Value::String("version".into()))
    .or_insert(Value::Number(1.into()));
  root
    .entry(Value::String("accounts".into()))
    .or_insert(Value::Sequence(Vec::new()));
  if root.get("accounts").and_then(Value::as_sequence).is_none() {
    return Err("Saved Tokn accounts could not be read. Review them in Advanced.".into());
  }
  Ok(root)
}

pub fn account_summaries(document: &Document) -> Vec<ToknAccountSummary> {
  let Ok(root) = auth_document(&document.credentials_yaml) else {
    return Vec::new();
  };
  let registry = Registry::builtin();
  root["accounts"]
    .as_sequence()
    .into_iter()
    .flatten()
    .filter_map(|account| {
      let account_id = account.get("id")?.as_str()?;
      let provider_id = account
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("github-copilot");
      Some(ToknAccountSummary {
        account_id: account_id.into(),
        provider_id: provider_id.into(),
        display_name: registry
          .resolve(provider_id)
          .map(|d| d.display_name)
          .unwrap_or(provider_id)
          .into(),
        enabled: account
          .get("enabled")
          .and_then(Value::as_bool)
          .unwrap_or(true),
        has_api_key: account
          .get("api_key")
          .and_then(Value::as_str)
          .is_some_and(|key| !key.is_empty()),
        managed: document
          .setup_accounts
          .get(provider_id)
          .is_some_and(|id| id == account_id),
      })
    })
    .collect()
}

pub(super) fn connect(input: ToknConnectInput, existing: &Document) -> Result<Document, String> {
  if !PROVIDERS.contains(&input.provider_id.as_str()) {
    return Err("Choose a supported API-key provider.".into());
  }
  let api_key = input.api_key.trim();
  if api_key.is_empty() || api_key.len() > 8192 || api_key.chars().any(char::is_control) {
    return Err("Enter an API key of at most 8192 bytes without line breaks.".into());
  }
  let defaults = model_ids(&input.provider_id);
  if defaults.is_empty() {
    return Err("No compatible models are available for this provider in Tokn's catalogue. Use Advanced to configure it.".into());
  }
  let mut root = auth_document(&existing.credentials_yaml)?;
  let accounts = root
    .get_mut("accounts")
    .and_then(Value::as_sequence_mut)
    .expect("validated accounts");
  let existing_id = existing.setup_accounts.get(&input.provider_id);
  let index = accounts.iter().position(|account| {
    existing_id.is_some_and(|id| account.get("id").and_then(Value::as_str) == Some(id))
      && account.get("provider").and_then(Value::as_str) == Some(input.provider_id.as_str())
  });
  let account_id = if let Some(index) = index {
    let account = accounts[index]
      .as_mapping_mut()
      .ok_or("Saved guided account is malformed.")?;
    account.insert(
      Value::String("api_key".into()),
      Value::String(api_key.into()),
    );
    account.insert(Value::String("enabled".into()), Value::Bool(true));
    existing_id.expect("matched account").clone()
  } else {
    let id = format!("rrbox-{}", uuid::Uuid::new_v4());
    let account = serde_json::json!({
      "id": id, "provider": input.provider_id, "api_key": api_key, "enabled": true,
    });
    accounts.push(serde_yaml::to_value(account).map_err(|_| "Could not generate Tokn account.")?);
    id
  };
  let credentials =
    serde_yaml::to_string(&root).map_err(|_| "Could not generate Tokn credentials.")?;
  let mut model_ids = existing.model_ids.clone();
  model_ids.extend(defaults);
  model_ids.sort();
  model_ids.dedup();
  let mut next = normalize_input(
    ToknSettingsInput {
      enabled: true,
      config_toml: existing.config_toml.clone(),
      credentials_yaml: Some(credentials),
      model_ids,
    },
    existing,
  )?;
  next.setup_accounts = existing.setup_accounts.clone();
  next.setup_accounts.insert(input.provider_id, account_id);
  Ok(next)
}

#[cfg(test)]
#[path = "tokn_setup_tests.rs"]
mod tests;
