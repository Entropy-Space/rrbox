use super::super::{DEFAULT_CONFIG, EmbeddedTokn};
use super::*;
use std::{fs, sync::Arc};

fn connect_input(provider: &str, key: &str) -> ToknConnectInput {
  ToknConnectInput {
    provider_id: provider.into(),
    api_key: key.into(),
  }
}

#[tokio::test]
async fn every_guided_provider_initializes_and_populates_models_without_network() {
  let presets = providers();
  assert_eq!(presets.len(), 6);
  for preset in presets {
    assert!(preset.model_count > 0, "{}", preset.provider_id);
    let root = tempfile::tempdir().unwrap();
    let engine = EmbeddedTokn::new(root.path().into()).unwrap();
    engine
      .connect(connect_input(&preset.provider_id, " test-key-secret "))
      .unwrap();
    let snapshot = engine.snapshot().unwrap();
    assert!(snapshot.enabled);
    assert_eq!(snapshot.status, "ready");
    assert_eq!(snapshot.model_ids.len(), preset.model_count);
    assert!(
      snapshot
        .model_ids
        .iter()
        .all(|id| id.starts_with(&format!("{}/", preset.provider_id)))
    );
    assert_eq!(snapshot.accounts.len(), 1);
    assert!(snapshot.accounts[0].managed);
    assert!(snapshot.accounts[0].has_api_key);
    assert!(
      !serde_json::to_string(&snapshot)
        .unwrap()
        .contains("test-key-secret")
    );
    let value: serde_json::Value =
      serde_json::from_slice(&fs::read(root.path().join("embedded-tokn.json")).unwrap()).unwrap();
    let auth = auth_document(value["credentials_yaml"].as_str().unwrap()).unwrap();
    assert_eq!(
      auth["accounts"][0]["api_key"].as_str(),
      Some("test-key-secret")
    );
  }
}

#[tokio::test]
async fn reconnect_replaces_only_owned_key_after_restart_and_keeps_other_accounts_and_routing() {
  let root = tempfile::tempdir().unwrap();
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  let config = "# keep my routing\n[defaults]\nmode = \"exact\"\n";
  let credentials = "version: 1\naccounts:\n  - id: imported\n    provider: deepseek\n    api_key: imported-secret\n    enabled: false\n    tags: [personal]\n    settings: {example: preserved}\n";
  // A loaded disabled configuration need not have an active SDK account yet.
  engine.state.lock().unwrap().document = Document {
    config_toml: config.into(),
    model_ids: vec!["my-routing-alias".into()],
    credentials_yaml: credentials.into(),
    ..Document::default()
  };
  engine
    .connect(connect_input("deepseek", "first-secret"))
    .unwrap();
  let account_id = engine
    .snapshot()
    .unwrap()
    .accounts
    .into_iter()
    .find(|a| a.managed)
    .unwrap()
    .account_id;
  drop(engine);
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  let first = engine.client().unwrap();
  engine
    .connect(connect_input("deepseek", "quoted: \"key\" # value"))
    .unwrap();
  assert!(!Arc::ptr_eq(&first, &engine.client().unwrap()));
  assert!(first.client.auth_path().exists());
  let snapshot = engine.snapshot().unwrap();
  assert_eq!(snapshot.config_toml, config);
  assert!(snapshot.model_ids.contains(&"my-routing-alias".into()));
  assert_eq!(snapshot.accounts.len(), 2);
  assert!(
    snapshot
      .accounts
      .iter()
      .any(|a| a.account_id == account_id && a.managed)
  );
  let state = engine.state.lock().unwrap();
  let auth = auth_document(&state.document.credentials_yaml).unwrap();
  let before = auth_document(credentials).unwrap();
  assert_eq!(auth["accounts"][0], before["accounts"][0]);
  assert_eq!(
    auth["accounts"][1]["api_key"].as_str(),
    Some("quoted: \"key\" # value")
  );
  assert!(!state.document.credentials_yaml.contains("first-secret"));
}

#[tokio::test]
async fn multiple_providers_coexist_and_invalid_connect_keeps_live_state() {
  let root = tempfile::tempdir().unwrap();
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  engine
    .connect(connect_input("deepseek", "first-secret"))
    .unwrap();
  engine
    .connect(connect_input("zai-coding-plan", "second-secret"))
    .unwrap();
  assert_eq!(engine.snapshot().unwrap().accounts.len(), 2);
  let original = fs::read(root.path().join("embedded-tokn.json")).unwrap();
  let client = engine.client().unwrap();
  for input in [
    connect_input("unknown", "secret"),
    connect_input("openai", " \n "),
    connect_input("openai", "secret\ninjected"),
    connect_input("openai", &"x".repeat(8193)),
  ] {
    let error = engine.connect(input).unwrap_err();
    assert!(!error.contains("secret"));
    assert_eq!(
      original,
      fs::read(root.path().join("embedded-tokn.json")).unwrap()
    );
    assert!(Arc::ptr_eq(&client, &engine.client().unwrap()));
  }
}

#[test]
fn advanced_credential_replacement_relinquishes_ownership_and_legacy_documents_load() {
  let original = Document::default();
  let first = connect(connect_input("deepseek", "original-secret"), &original).unwrap();
  let mut advanced = super::super::normalize_input(
    ToknSettingsInput {
      enabled: true,
      config_toml: DEFAULT_CONFIG.into(),
      model_ids: first.model_ids.clone(),
      credentials_yaml: None,
    },
    &first,
  )
  .unwrap();
  assert_eq!(advanced.setup_accounts, first.setup_accounts);
  advanced = super::super::normalize_input(
    ToknSettingsInput {
      enabled: true,
      config_toml: DEFAULT_CONFIG.into(),
      model_ids: first.model_ids.clone(),
      credentials_yaml: Some(first.credentials_yaml.clone()),
    },
    &first,
  )
  .unwrap();
  assert!(advanced.setup_accounts.is_empty());
  let next = connect(connect_input("deepseek", "new-secret"), &advanced).unwrap();
  let auth = auth_document(&next.credentials_yaml).unwrap();
  assert_eq!(auth["accounts"].as_sequence().unwrap().len(), 2);
  assert_eq!(
    auth["accounts"][0]["api_key"].as_str(),
    Some("original-secret")
  );
  let mut legacy = serde_json::to_value(first).unwrap();
  legacy.as_object_mut().unwrap().remove("setup_accounts");
  assert!(
    serde_json::from_value::<Document>(legacy)
      .unwrap()
      .setup_accounts
      .is_empty()
  );
}

#[test]
fn malformed_credentials_and_excessive_models_are_not_replaced() {
  for credentials in [
    "accounts: [ secret",
    "version: 2\naccounts: []",
    "accounts: not-a-list",
    "[]",
  ] {
    let existing = Document {
      credentials_yaml: credentials.into(),
      ..Document::default()
    };
    let error = connect(connect_input("openai", "new-secret"), &existing)
      .err()
      .unwrap();
    assert!(!error.contains("secret"));
    assert_eq!(existing.credentials_yaml, credentials);
  }
  let existing = Document {
    model_ids: (0..1000).map(|n| format!("manual-{n}")).collect(),
    ..Document::default()
  };
  assert!(connect(connect_input("openai", "new-secret"), &existing).is_err());
}

#[test]
fn generated_models_omit_known_responses_only_families() {
  let models = model_ids("openai");
  assert!(models.contains(&"openai/gpt-4o-mini".into()));
  assert!(models.iter().all(|id| {
    !["codex", "-pro", "deep-research"]
      .iter()
      .any(|part| id.contains(part))
  }));
}
