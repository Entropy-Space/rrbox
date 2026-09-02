use std::{
  collections::{BTreeMap, HashMap},
  path::PathBuf,
  sync::{Arc, Mutex},
  time::Duration,
};

use super::embedded_tokn::{self, EmbeddedTokn};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use futures_util::StreamExt;
use reqwest::{
  Client, Response, StatusCode,
  header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderName, HeaderValue},
  redirect::Policy,
};
use serde_json::Value;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::protocol::{
  NATIVE_PROVIDER_PROTOCOL_VERSION, NativeProviderBodyEvent, NativeProviderBodyEventPayload,
  NativeProviderBodyStatus, NativeProviderCancelRequest, NativeProviderEndpoint,
  NativeProviderFetchRequest, NativeProviderMethod,
};
use super::settings::{
  ProviderConfiguration, ProviderConfigurationInput, ProviderSettingsError,
  ProviderSettingsSnapshot, ProviderSettingsStore, ProviderTestResult,
};

const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHANNEL_CHUNK_BYTES: usize = 64 * 1024;
const MAX_ERROR_MESSAGE_BYTES: usize = 500;
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const CHAT_COMPLETIONS_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

type EventSink = Arc<dyn Fn(NativeProviderBodyEvent) -> Result<(), ()> + Send + Sync + 'static>;

#[derive(Clone)]
pub struct ProviderService {
  inner: Arc<ProviderServiceInner>,
}

struct ProviderServiceInner {
  client: Client,
  settings: ProviderSettingsStore,
  embedded_tokn: Option<Arc<EmbeddedTokn>>,
  active_operations: Mutex<HashMap<String, CancellationToken>>,
  models_timeout: Duration,
  chat_completions_timeout: Duration,
}

struct PreparedFetch {
  operation_id: String,
  provider: ProviderConfiguration,
  endpoint: NativeProviderEndpoint,
  body: Option<String>,
  session_affinity_headers: BTreeMap<String, String>,
  timeout: Duration,
}

struct EventEmitter {
  operation_id: String,
  event_index: u64,
  sink: EventSink,
}

enum RunOutcome {
  Complete,
  Aborted,
  Error(String),
  ChannelClosed,
}

#[derive(Debug, Error)]
pub enum ProviderServiceError {
  #[error("{0}")]
  InvalidRequest(String),
  #[error("{0}")]
  ProviderUnavailable(String),
  #[error("{0}")]
  Internal(String),
}

impl ProviderServiceError {
  pub fn code(&self) -> &'static str {
    match self {
      Self::InvalidRequest(_) => "invalid_request",
      Self::ProviderUnavailable(_) => "provider_unavailable",
      Self::Internal(_) => "internal",
    }
  }
}

impl ProviderService {
  pub fn new(root: PathBuf) -> Result<Self, ProviderServiceError> {
    let settings = ProviderSettingsStore::load(root.clone())?;
    let embedded = EmbeddedTokn::new(root).map_err(ProviderServiceError::Internal)?;
    Self::with_configuration(
      settings,
      MODELS_TIMEOUT,
      CHAT_COMPLETIONS_TIMEOUT,
      Some(Arc::new(embedded)),
    )
  }

  fn with_configuration(
    settings: ProviderSettingsStore,
    models_timeout: Duration,
    chat_completions_timeout: Duration,
    embedded_tokn: Option<Arc<EmbeddedTokn>>,
  ) -> Result<Self, ProviderServiceError> {
    let client = Client::builder()
      .redirect(Policy::none())
      .no_proxy()
      .connect_timeout(CONNECT_TIMEOUT)
      .build()
      .map_err(|error| ProviderServiceError::Internal(error.to_string()))?;
    Ok(Self {
      inner: Arc::new(ProviderServiceInner {
        client,
        settings,
        embedded_tokn,
        active_operations: Mutex::new(HashMap::new()),
        models_timeout,
        chat_completions_timeout,
      }),
    })
  }

  pub fn start_fetch(
    &self,
    request: NativeProviderFetchRequest,
    send_event: impl Fn(NativeProviderBodyEvent) -> Result<(), ()> + Send + Sync + 'static,
  ) -> Result<String, ProviderServiceError> {
    let prepared = self.prepare_fetch(request)?;
    let operation_id = prepared.operation_id.clone();
    let cancellation = CancellationToken::new();
    {
      let mut active = self.active_operations()?;
      if active.contains_key(&operation_id) {
        return Err(ProviderServiceError::InvalidRequest(format!(
          "Provider operation {operation_id} is already active."
        )));
      }
      active.insert(operation_id.clone(), cancellation.clone());
    }

    let service = self.clone();
    tauri::async_runtime::spawn(async move {
      service
        .run_operation(prepared, cancellation, Arc::new(send_event))
        .await;
    });
    Ok(operation_id)
  }

  pub fn settings_snapshot(&self) -> Result<ProviderSettingsSnapshot, ProviderServiceError> {
    let mut snapshot = self.inner.settings.snapshot()?;
    if let Some(tokn) = &self.inner.embedded_tokn {
      snapshot.providers.push(
        tokn
          .public_provider()
          .map_err(ProviderServiceError::Internal)?,
      );
      snapshot.embedded_tokn = Some(tokn.snapshot().map_err(ProviderServiceError::Internal)?);
    }
    Ok(snapshot)
  }

  pub(super) fn tokn(&self) -> Result<Arc<EmbeddedTokn>, String> {
    self
      .inner
      .embedded_tokn
      .clone()
      .ok_or_else(|| "Embedded tokn is unavailable.".into())
  }

  pub fn save_settings(
    &self,
    input: ProviderConfigurationInput,
  ) -> Result<ProviderSettingsSnapshot, ProviderServiceError> {
    if input.provider_id == embedded_tokn::PROVIDER_ID {
      return Err(ProviderServiceError::InvalidRequest(
        "Use embedded tokn settings for this provider.".into(),
      ));
    }
    self.inner.settings.save(input)?;
    self.settings_snapshot()
  }

  pub fn remove_settings(
    &self,
    provider_id: &str,
  ) -> Result<ProviderSettingsSnapshot, ProviderServiceError> {
    if provider_id == embedded_tokn::PROVIDER_ID {
      return Err(ProviderServiceError::InvalidRequest(
        "Disable embedded tokn in its settings instead.".into(),
      ));
    }
    self.inner.settings.remove(provider_id)?;
    self.settings_snapshot()
  }

  pub async fn test_settings(
    &self,
    input: ProviderConfigurationInput,
  ) -> Result<ProviderTestResult, ProviderServiceError> {
    let provider = self.inner.settings.resolve_input(input)?;
    let mut request = self
      .inner
      .client
      .get(format!("{}/models", provider.base_url))
      .header(ACCEPT, "application/json")
      .timeout(self.inner.models_timeout);
    if let Some(api_key) = &provider.api_key {
      request = request.header(AUTHORIZATION, bearer_header(api_key)?);
    }
    let response = request
      .send()
      .await
      .map_err(|error| ProviderServiceError::ProviderUnavailable(provider_request_error(error)))?;
    let status = response.status();
    let body = collect_bounded_body(response).await?;
    if !status.is_success() {
      let detail = String::from_utf8_lossy(&body);
      return Err(ProviderServiceError::ProviderUnavailable(format!(
        "Models endpoint returned {}{}",
        status.as_u16(),
        if detail.is_empty() {
          ".".into()
        } else {
          format!(": {}", bound_error_message(detail.into_owned()))
        }
      )));
    }
    let payload: Value = serde_json::from_slice(&body).map_err(|error| {
      ProviderServiceError::ProviderUnavailable(format!(
        "Models endpoint returned malformed JSON: {error}"
      ))
    })?;
    let models = payload
      .get("data")
      .and_then(Value::as_array)
      .ok_or_else(|| {
        ProviderServiceError::ProviderUnavailable(
          "Models endpoint response must contain a data array.".into(),
        )
      })?;
    let mut model_ids = Vec::with_capacity(models.len());
    for (index, model) in models.iter().enumerate() {
      let model_id = model
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
          ProviderServiceError::ProviderUnavailable(format!(
            "Models endpoint data[{index}].id must be a non-empty string."
          ))
        })?;
      if !model_ids.iter().any(|existing| existing == model_id) {
        model_ids.push(model_id.to_owned());
      }
    }
    model_ids.sort();
    Ok(ProviderTestResult { model_ids })
  }

  pub fn cancel(
    &self,
    request: &NativeProviderCancelRequest,
  ) -> Result<bool, ProviderServiceError> {
    validate_protocol_and_identifier(request.protocol_version, &request.request_id, "request_id")?;
    validate_identifier(&request.operation_id, "operation_id")?;

    let cancellation = self
      .active_operations()?
      .get(&request.operation_id)
      .cloned();
    if let Some(cancellation) = cancellation {
      cancellation.cancel();
      Ok(true)
    } else {
      Ok(false)
    }
  }

  fn prepare_fetch(
    &self,
    request: NativeProviderFetchRequest,
  ) -> Result<PreparedFetch, ProviderServiceError> {
    validate_protocol_and_identifier(request.protocol_version, &request.request_id, "request_id")?;
    validate_identifier(&request.operation_id, "operation_id")?;
    let provider = if request.provider_id == embedded_tokn::PROVIDER_ID {
      self
        .tokn()
        .map_err(ProviderServiceError::ProviderUnavailable)?
        .provider()
        .map_err(ProviderServiceError::ProviderUnavailable)?
    } else {
      self
        .inner
        .settings
        .resolve(&request.provider_id)?
        .ok_or_else(|| {
          ProviderServiceError::ProviderUnavailable(format!(
            "Provider {} is not configured or is disabled.",
            request.provider_id
          ))
        })?
    };

    if !provider.enabled {
      return Err(ProviderServiceError::ProviderUnavailable(
        "This provider is disabled.".into(),
      ));
    }
    let timeout = match (request.endpoint, request.method, request.body.as_ref()) {
      (NativeProviderEndpoint::Models, NativeProviderMethod::Get, None) => {
        self.inner.models_timeout
      }
      (NativeProviderEndpoint::ChatCompletions, NativeProviderMethod::Post, Some(body)) => {
        validate_chat_request_body(body)?;
        self.inner.chat_completions_timeout
      }
      (NativeProviderEndpoint::Models, _, _) => {
        return Err(ProviderServiceError::InvalidRequest(
          "The models endpoint requires GET without a request body.".into(),
        ));
      }
      (NativeProviderEndpoint::ChatCompletions, _, _) => {
        return Err(ProviderServiceError::InvalidRequest(
          "The chat_completions endpoint requires POST with a JSON request body.".into(),
        ));
      }
    };
    validate_session_affinity_headers(request.endpoint, &request.session_affinity_headers)?;
    if !provider.send_session_affinity_headers && !request.session_affinity_headers.is_empty() {
      return Err(ProviderServiceError::InvalidRequest(
        "Session-affinity headers are disabled for this provider.".into(),
      ));
    }

    Ok(PreparedFetch {
      operation_id: request.operation_id,
      provider,
      endpoint: request.endpoint,
      body: request.body,
      session_affinity_headers: request.session_affinity_headers,
      timeout,
    })
  }

  async fn run_operation(
    &self,
    prepared: PreparedFetch,
    cancellation: CancellationToken,
    sink: EventSink,
  ) {
    let operation_id = prepared.operation_id.clone();
    let mut emitter = EventEmitter::new(operation_id.clone(), sink);
    let outcome = self.run_fetch(&prepared, &cancellation, &mut emitter).await;

    self.remove_active_operation(&operation_id, &cancellation);
    match outcome {
      RunOutcome::Complete => {
        emitter.finish(NativeProviderBodyStatus::Complete, None);
      }
      RunOutcome::Aborted => {
        emitter.finish(NativeProviderBodyStatus::Aborted, None);
      }
      RunOutcome::Error(message) => {
        emitter.finish(
          NativeProviderBodyStatus::Error,
          Some(bound_error_message(message)),
        );
      }
      RunOutcome::ChannelClosed => {}
    }
  }

  async fn run_fetch(
    &self,
    prepared: &PreparedFetch,
    cancellation: &CancellationToken,
    emitter: &mut EventEmitter,
  ) -> RunOutcome {
    if prepared.provider.provider_id == embedded_tokn::PROVIDER_ID {
      return match tokio::time::timeout(
        prepared.timeout,
        self.run_tokn_fetch(prepared, cancellation, emitter),
      )
      .await
      {
        Ok(outcome) => outcome,
        Err(_) => RunOutcome::Error("Embedded tokn request timed out.".into()),
      };
    }
    let url = format!("{}{}", prepared.provider.base_url, prepared.endpoint.path());
    let mut request = match prepared.endpoint {
      NativeProviderEndpoint::Models => self
        .inner
        .client
        .get(url)
        .header(ACCEPT, "application/json"),
      NativeProviderEndpoint::ChatCompletions => self
        .inner
        .client
        .post(url)
        .header(ACCEPT, "text/event-stream")
        .header(CONTENT_TYPE, "application/json")
        .body(prepared.body.clone().unwrap_or_default()),
    };
    for (name, value) in &prepared.session_affinity_headers {
      request = request.header(name, value);
    }
    if let Some(api_key) = &prepared.provider.api_key {
      let authorization = match bearer_header(api_key) {
        Ok(value) => value,
        Err(error) => return RunOutcome::Error(error.to_string()),
      };
      request = request.header(AUTHORIZATION, authorization);
    }
    let request = request.timeout(prepared.timeout);

    let response = tokio::select! {
      biased;
      _ = cancellation.cancelled() => return RunOutcome::Aborted,
      response = request.send() => match response {
        Ok(response) => response,
        Err(error) => {
          if cancellation.is_cancelled() {
            return RunOutcome::Aborted;
          }
          return RunOutcome::Error(provider_request_error(error));
        }
      },
    };

    self.stream_response(response, cancellation, emitter).await
  }

  async fn run_tokn_fetch(
    &self,
    prepared: &PreparedFetch,
    cancellation: &CancellationToken,
    emitter: &mut EventEmitter,
  ) -> RunOutcome {
    let engine = match self.tokn() {
      Ok(engine) => engine,
      Err(message) => return RunOutcome::Error(message),
    };
    if cancellation.is_cancelled() {
      return RunOutcome::Aborted;
    }
    if prepared.endpoint == NativeProviderEndpoint::Models {
      let models = match engine.models() {
        Ok(models) => models,
        Err(message) => return RunOutcome::Error(message),
      };
      if !emitter.response_started(
        StatusCode::OK,
        BTreeMap::from([("content-type".into(), "application/json".into())]),
      ) {
        return RunOutcome::ChannelClosed;
      }
      for part in models
        .to_string()
        .as_bytes()
        .chunks(MAX_CHANNEL_CHUNK_BYTES)
      {
        if cancellation.is_cancelled() {
          return RunOutcome::Aborted;
        }
        if !emitter.body_chunk(part) {
          return RunOutcome::ChannelClosed;
        }
      }
      return RunOutcome::Complete;
    }
    let worker = tauri::async_runtime::spawn_blocking(move || engine.client());
    let runtime = tokio::select! {
      biased;
      _ = cancellation.cancelled() => return RunOutcome::Aborted,
      result = worker => match result {
        Ok(Ok(runtime)) => runtime,
        Ok(Err(message)) => return RunOutcome::Error(message),
        Err(_) => return RunOutcome::Error("Embedded tokn initialization failed.".into()),
      },
    };
    let body: Value = match serde_json::from_str(prepared.body.as_deref().unwrap_or("")) {
      Ok(body) => body,
      Err(_) => return RunOutcome::Error("Invalid embedded model request.".into()),
    };
    let mut options = tokn_sdk::RequestOptions::default().with_request_id(&prepared.operation_id);
    if let Some(session) = prepared.session_affinity_headers.get("session_id") {
      options = options.with_session_id(session);
    }
    let response = tokio::select! {
      biased;
      _ = cancellation.cancelled() => return RunOutcome::Aborted,
      result = runtime.client.execute(tokn_sdk::Endpoint::ChatCompletions, body, options) => match result {
        Ok(response) => response,
        Err(_) => return RunOutcome::Error("Embedded tokn request failed. Check the model selector, route, and account credentials.".into()),
      },
    };
    let status = match StatusCode::from_u16(response.status) {
      Ok(status) => status,
      Err(_) => return RunOutcome::Error("Invalid embedded response status.".into()),
    };
    let mut headers = BTreeMap::new();
    for (name, value) in response.headers.iter() {
      if matches!(
        name.as_str(),
        "content-type" | "retry-after" | "x-request-id"
      ) {
        headers.insert(name.as_str().to_owned(), value.as_str().to_owned());
      }
    }
    if !emitter.response_started(status, headers) {
      return RunOutcome::ChannelClosed;
    }
    let mut stream: tokn_sdk::ByteStream = match response.body {
      tokn_sdk::ResponseBody::Stream(stream) => stream,
      tokn_sdk::ResponseBody::Buffered(bytes) => {
        Box::pin(futures_util::stream::once(async move { Ok(bytes) }))
      }
    };
    let mut received = 0_usize;
    loop {
      let chunk = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return RunOutcome::Aborted,
        chunk = stream.next() => chunk,
      };
      let chunk = match chunk {
        None => return RunOutcome::Complete,
        Some(Ok(chunk)) => chunk,
        Some(Err(_)) => return RunOutcome::Error("Embedded tokn response stream failed.".into()),
      };
      received = match received.checked_add(chunk.len()) {
        Some(size) if size <= MAX_RESPONSE_BYTES => size,
        _ => return RunOutcome::Error("The provider response body is too large.".into()),
      };
      for part in chunk.chunks(MAX_CHANNEL_CHUNK_BYTES) {
        if cancellation.is_cancelled() {
          return RunOutcome::Aborted;
        }
        if !emitter.body_chunk(part) {
          return RunOutcome::ChannelClosed;
        }
      }
    }
  }

  async fn stream_response(
    &self,
    response: Response,
    cancellation: &CancellationToken,
    emitter: &mut EventEmitter,
  ) -> RunOutcome {
    if !response.status().is_success()
      && !response.status().is_redirection()
      && !response.status().is_client_error()
      && !response.status().is_server_error()
    {
      return RunOutcome::Error("The provider returned an unsupported HTTP status.".into());
    }
    let declared_length = response.content_length();
    if !emitter.response_started(response.status(), filtered_response_headers(&response)) {
      return RunOutcome::ChannelClosed;
    }
    if declared_length.is_some_and(|length| length > MAX_RESPONSE_BYTES as u64) {
      return RunOutcome::Error("The provider response body is too large.".into());
    }

    let mut received_bytes = 0_usize;
    let mut body = response.bytes_stream();
    loop {
      let next = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return RunOutcome::Aborted,
        next = body.next() => next,
      };
      let Some(chunk) = next else {
        return RunOutcome::Complete;
      };
      let chunk = match chunk {
        Ok(chunk) => chunk,
        Err(error) => {
          if cancellation.is_cancelled() {
            return RunOutcome::Aborted;
          }
          return RunOutcome::Error(provider_request_error(error));
        }
      };

      received_bytes = match received_bytes.checked_add(chunk.len()) {
        Some(size) if size <= MAX_RESPONSE_BYTES => size,
        _ => {
          return RunOutcome::Error("The provider response body is too large.".into());
        }
      };
      for part in chunk.chunks(MAX_CHANNEL_CHUNK_BYTES) {
        if cancellation.is_cancelled() {
          return RunOutcome::Aborted;
        }
        if !part.is_empty() && !emitter.body_chunk(part) {
          return RunOutcome::ChannelClosed;
        }
      }
    }
  }

  fn active_operations(
    &self,
  ) -> Result<std::sync::MutexGuard<'_, HashMap<String, CancellationToken>>, ProviderServiceError>
  {
    self.inner.active_operations.lock().map_err(|_| {
      ProviderServiceError::Internal(
        "The native provider operation registry is unavailable.".into(),
      )
    })
  }

  fn remove_active_operation(&self, operation_id: &str, cancellation: &CancellationToken) {
    if let Ok(mut active) = self.inner.active_operations.lock()
      && active
        .get(operation_id)
        .is_some_and(|registered| registered == cancellation)
    {
      active.remove(operation_id);
    }
  }

  #[cfg(test)]
  fn new_for_test(
    base_url: String,
    models_timeout: Duration,
    chat_completions_timeout: Duration,
  ) -> Self {
    Self::with_configuration(
      ProviderSettingsStore::in_memory(base_url),
      models_timeout,
      chat_completions_timeout,
      None,
    )
    .expect("create test provider service")
  }

  #[cfg(test)]
  fn active_operation_count(&self) -> usize {
    self
      .inner
      .active_operations
      .lock()
      .expect("lock active operations")
      .len()
  }
}

fn validate_session_affinity_headers(
  endpoint: NativeProviderEndpoint,
  headers: &BTreeMap<String, String>,
) -> Result<(), ProviderServiceError> {
  if headers.is_empty() {
    return Ok(());
  }
  if endpoint != NativeProviderEndpoint::ChatCompletions {
    return Err(ProviderServiceError::InvalidRequest(
      "Session-affinity headers are only valid for chat completions.".into(),
    ));
  }

  let allowed = ["session_id", "x-client-request-id", "x-session-affinity"];
  let mut affinity_value: Option<&str> = None;
  for (name, value) in headers {
    if !allowed.contains(&name.as_str()) {
      return Err(ProviderServiceError::InvalidRequest(format!(
        "Unsupported native provider request header: {name}."
      )));
    }
    HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
      ProviderServiceError::InvalidRequest(format!(
        "Invalid native provider request header name: {name}."
      ))
    })?;
    HeaderValue::from_str(value).map_err(|_| {
      ProviderServiceError::InvalidRequest(format!(
        "Invalid native provider request header value for {name}."
      ))
    })?;
    if value.is_empty() {
      return Err(ProviderServiceError::InvalidRequest(format!(
        "Native provider request header {name} must not be empty."
      )));
    }
    if let Some(previous) = affinity_value {
      if previous != value {
        return Err(ProviderServiceError::InvalidRequest(
          "Native provider session-affinity headers must use the same value.".into(),
        ));
      }
    } else {
      affinity_value = Some(value);
    }
  }
  Ok(())
}

impl From<ProviderSettingsError> for ProviderServiceError {
  fn from(error: ProviderSettingsError) -> Self {
    match error {
      ProviderSettingsError::Invalid(message) => Self::InvalidRequest(message),
      ProviderSettingsError::Internal(message) => Self::Internal(message),
    }
  }
}

fn bearer_header(api_key: &str) -> Result<HeaderValue, ProviderServiceError> {
  HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
    ProviderServiceError::InvalidRequest(
      "The configured provider API key cannot be used as an authorization header.".into(),
    )
  })
}

async fn collect_bounded_body(response: Response) -> Result<Vec<u8>, ProviderServiceError> {
  if response
    .content_length()
    .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
  {
    return Err(ProviderServiceError::ProviderUnavailable(
      "The provider response body is too large.".into(),
    ));
  }
  let mut body = Vec::new();
  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk
      .map_err(|error| ProviderServiceError::ProviderUnavailable(provider_request_error(error)))?;
    if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
      return Err(ProviderServiceError::ProviderUnavailable(
        "The provider response body is too large.".into(),
      ));
    }
    body.extend_from_slice(&chunk);
  }
  Ok(body)
}

impl EventEmitter {
  fn new(operation_id: String, sink: EventSink) -> Self {
    Self {
      operation_id,
      event_index: 0,
      sink,
    }
  }

  fn response_started(&mut self, status: StatusCode, headers: BTreeMap<String, String>) -> bool {
    self.emit(NativeProviderBodyEventPayload::ResponseStarted {
      status: status.as_u16(),
      status_text: status.canonical_reason().unwrap_or("").to_owned(),
      headers,
    })
  }

  fn body_chunk(&mut self, chunk: &[u8]) -> bool {
    self.emit(NativeProviderBodyEventPayload::BodyChunk {
      chunk_base64: BASE64_STANDARD.encode(chunk),
    })
  }

  fn finish(&mut self, status: NativeProviderBodyStatus, error_message: Option<String>) {
    let _ = self.emit(NativeProviderBodyEventPayload::BodyFinished {
      status,
      error_message,
    });
  }

  fn emit(&mut self, payload: NativeProviderBodyEventPayload) -> bool {
    let event = NativeProviderBodyEvent {
      protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
      operation_id: self.operation_id.clone(),
      event_index: self.event_index,
      payload,
    };
    if (self.sink)(event).is_err() {
      return false;
    }
    self.event_index += 1;
    true
  }
}

fn validate_protocol_and_identifier(
  protocol_version: u32,
  identifier: &str,
  field: &str,
) -> Result<(), ProviderServiceError> {
  if protocol_version != NATIVE_PROVIDER_PROTOCOL_VERSION {
    return Err(ProviderServiceError::InvalidRequest(format!(
      "Unsupported native provider protocol version: {protocol_version}."
    )));
  }
  validate_identifier(identifier, field)
}

fn validate_identifier(value: &str, field: &str) -> Result<(), ProviderServiceError> {
  if value.is_empty() || value.len() > MAX_IDENTIFIER_BYTES || value.trim() != value {
    return Err(ProviderServiceError::InvalidRequest(format!(
      "{field} must be a trimmed, non-empty string of at most {MAX_IDENTIFIER_BYTES} bytes."
    )));
  }
  Ok(())
}

fn validate_chat_request_body(body: &str) -> Result<(), ProviderServiceError> {
  if body.len() > MAX_REQUEST_BYTES {
    return Err(ProviderServiceError::InvalidRequest(
      "The provider request body is too large.".into(),
    ));
  }
  let value: Value = serde_json::from_str(body).map_err(|_| {
    ProviderServiceError::InvalidRequest(
      "The chat_completions request body must be valid JSON.".into(),
    )
  })?;
  if !value.is_object() {
    return Err(ProviderServiceError::InvalidRequest(
      "The chat_completions request body must be a JSON object.".into(),
    ));
  }
  Ok(())
}

fn filtered_response_headers(response: &Response) -> BTreeMap<String, String> {
  let mut headers = BTreeMap::new();
  for name in ["content-type", "x-request-id"] {
    if let Some(value) = response.headers().get(name)
      && let Ok(value) = value.to_str()
    {
      headers.insert(name.to_owned(), value.to_owned());
    }
  }
  headers.insert("cache-control".into(), "no-store".into());
  headers
}

fn provider_request_error(error: reqwest::Error) -> String {
  if error.is_timeout() {
    "The provider request timed out.".into()
  } else {
    "The provider is unavailable.".into()
  }
}

fn bound_error_message(message: String) -> String {
  if message.len() <= MAX_ERROR_MESSAGE_BYTES {
    return message;
  }
  let mut boundary = MAX_ERROR_MESSAGE_BYTES;
  while !message.is_char_boundary(boundary) {
    boundary -= 1;
  }
  format!("{}…", &message[..boundary])
}

#[cfg(test)]
mod tests;
