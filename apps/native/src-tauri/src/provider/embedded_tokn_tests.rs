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
    assert!(text.contains("mock-model"));
    assert!(!text.contains("llama-cpp/mock-model"));
    let body = "data: {\"id\":\"mock\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"mock-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"embedded works\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
  });
  let root = tempfile::tempdir().unwrap();
  let engine = EmbeddedTokn::new(root.path().into()).unwrap();
  engine.save(input(&format!("http://{address}"))).unwrap();
  let runtime = engine.client().unwrap();
  let response = runtime.client.execute(tokn_sdk::Endpoint::ChatCompletions, serde_json::json!({
    "model": "llama-cpp/mock-model", "messages": [{"role": "user", "content": "hello"}], "stream": true,
  }), tokn_sdk::RequestOptions::default()).await.unwrap();
  assert_eq!(response.status, 200);
  let mut stream = response.into_stream().unwrap().into_stream();
  let mut bytes = Vec::new();
  while let Some(chunk) = stream.next().await {
    bytes.extend_from_slice(&chunk.unwrap());
  }
  assert!(String::from_utf8(bytes).unwrap().contains("embedded works"));
  server.await.unwrap();
}
