use super::*;
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn input(base_url: &str) -> ToknSettingsInput {
  ToknSettingsInput {
    enabled: true,
    config_toml: DEFAULT_CONFIG.into(),
    model_ids: vec!["llama-cpp/mock-model".into()],
    credentials_yaml: Some(format!(
      "version: 1\naccounts:\n  - id: local\n    provider: llama-cpp\n    base_url: {base_url}\n"
    )),
  }
}

#[test]
fn unconfigured_provider_does_not_read_gateway_accounts() {
  let root = tempfile::tempdir().unwrap();
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  let snapshot = engine.snapshot().unwrap();
  assert_eq!(snapshot.status, "unconfigured");
  assert!(!snapshot.has_credentials);
  assert!(!snapshot.enabled);
  assert!(engine.client().is_err());
  assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn model_metadata_uses_configured_accounts_and_keeps_advanced_aliases() {
  let root = tempfile::tempdir().unwrap();
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  engine.state.lock().unwrap().document = Document {
    enabled: true,
    credentials_yaml: "version: 1\naccounts:\n  - {id: a, provider: deepseek, api_key: private-key}\n  - {id: b, provider: deepseek, api_key: private-key}\n  - {id: c, provider: zai, enabled: false, api_key: private-key}\n".into(),
    model_ids: vec!["deepseek/deepseek-v4-flash".into(), "deepseek/custom-model".into(), "zai/glm-5".into(), "my-route".into()],
    ..Document::default()
  };
  let public = serde_json::to_value(engine.public_provider().unwrap()).unwrap();
  assert_eq!(
    public["upstream_providers"],
    serde_json::json!([
      {"provider_id": "deepseek", "display_name": "DeepSeek"}
    ])
  );
  let models = engine.models().unwrap();
  assert_eq!(models["data"].as_array().unwrap().len(), 3);
  let metadata = &models["data"][0]["x_tokn_router"];
  assert_eq!(metadata["name"], "DeepSeek V4 Flash");
  assert_eq!(metadata["upstream_provider_id"], "deepseek");
  assert_eq!(metadata["capabilities"]["reasoning"], true);
  assert_eq!(
    metadata["capabilities"]["reasoning_efforts"],
    serde_json::json!(["low", "high", "max"])
  );
  assert!(metadata["limit"]["context"].as_u64().unwrap() > 0);
  assert_eq!(
    models["data"][1]["x_tokn_router"]["upstream_provider_id"],
    "deepseek"
  );
  assert!(
    models["data"][1]["x_tokn_router"]
      .get("capabilities")
      .is_none()
  );
  assert_eq!(models["data"][2]["id"], "my-route");
  assert!(!format!("{public}{models}").contains("private-key"));
}

#[tokio::test]
async fn saves_validates_reloads_and_keeps_credentials_private() {
  let root = tempfile::tempdir().unwrap();
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  let mut settings = input("http://127.0.0.1:1");
  settings
    .credentials_yaml
    .as_mut()
    .unwrap()
    .push_str("    api_key: secret-test-token\n");
  engine.save(settings).unwrap();
  let snapshot = serde_json::to_string(&engine.snapshot().unwrap()).unwrap();
  assert!(!snapshot.contains("secret-test-token"));
  assert!(!snapshot.contains("credentials_yaml"));
  let first = engine.client().unwrap();
  engine.reload().unwrap();
  let second = engine.client().unwrap();
  assert!(!Arc::ptr_eq(&first, &second));
  assert!(first.client.config_path().exists());
  let reload = EmbeddedTokn::new(root.path().into()).unwrap();
  assert!(reload.snapshot().unwrap().has_credentials);
  let mut unchanged = input("http://unused.invalid");
  unchanged.credentials_yaml = None;
  reload.save(unchanged).unwrap();
  let saved = fs::read_to_string(root.path().join("embedded-tokn.json")).unwrap();
  assert!(saved.contains("secret-test-token"));
  assert!(!saved.contains("unused.invalid"));
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
      fs::metadata(root.path().join("embedded-tokn.json"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777,
      0o600
    );
  }
}

#[tokio::test]
async fn failed_save_is_atomic_and_does_not_expose_secrets() {
  let root = tempfile::tempdir().unwrap();
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  engine.save(input("http://127.0.0.1:1")).unwrap();
  let client = engine.client().unwrap();
  let original = fs::read(root.path().join("embedded-tokn.json")).unwrap();
  let mut invalid = input("http://127.0.0.1:1");
  invalid.credentials_yaml = Some("accounts: [ secret-value".into());
  let error = engine.save(invalid).unwrap_err();
  assert!(!error.contains("secret-value"));
  assert_eq!(
    original,
    fs::read(root.path().join("embedded-tokn.json")).unwrap()
  );
  assert!(Arc::ptr_eq(&client, &engine.client().unwrap()));
  assert!(parse_routing_config("[db]\nenabled = true\n").is_err());
  assert!(parse_routing_config("[agents.personal]\n").is_err());
}

#[tokio::test]
async fn executes_in_process_against_a_mock_upstream() {
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let address = listener.local_addr().unwrap();
  let server = tokio::spawn(async move {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut request = Vec::new();
    loop {
      let mut buffer = [0u8; 4096];
      let count = socket.read(&mut buffer).await.unwrap();
      assert!(count > 0);
      request.extend_from_slice(&buffer[..count]);
      if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
        let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
        let length: usize = headers
          .lines()
          .find_map(|line| line.strip_prefix("content-length: "))
          .unwrap()
          .parse()
          .unwrap();
        if request.len() >= header_end + 4 + length {
          break;
        }
      }
    }
    let text = String::from_utf8_lossy(&request);
    assert!(text.starts_with("POST /chat/completions "));
    let body_start = request
      .windows(4)
      .position(|part| part == b"\r\n\r\n")
      .unwrap()
      + 4;
    let request_body: serde_json::Value = serde_json::from_slice(&request[body_start..]).unwrap();
    assert_eq!(request_body["model"], "deepseek-v4-flash");
    assert_eq!(request_body["reasoning_effort"], "max");
    let body = "data: {\"id\":\"mock\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"deepseek-v4-flash\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"embedded works\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
  });
  let root = tempfile::tempdir().unwrap();
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  engine
    .save(ToknSettingsInput {
      enabled: true,
      config_toml: DEFAULT_CONFIG.into(),
      model_ids: vec!["deepseek/deepseek-v4-flash".into()],
      credentials_yaml: Some(format!(
        "version: 1\naccounts:\n  - id: local\n    provider: deepseek\n    base_url: http://{address}\n    api_key: sk-test\n"
      )),
    })
    .unwrap();
  let runtime = engine.client().unwrap();
  let response = runtime
    .client
    .execute(
      tokn_sdk::Endpoint::ChatCompletions,
      serde_json::json!({
        "model": "deepseek/deepseek-v4-flash", "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": "max", "stream": true,
      }),
      tokn_sdk::RequestOptions::default(),
    )
    .await
    .unwrap();
  assert_eq!(response.status, 200);
  let mut stream = response.into_stream().unwrap().into_stream();
  let mut bytes = Vec::new();
  while let Some(chunk) = stream.next().await {
    bytes.extend_from_slice(&chunk.unwrap());
  }
  assert!(String::from_utf8(bytes).unwrap().contains("embedded works"));
  server.await.unwrap();
}
