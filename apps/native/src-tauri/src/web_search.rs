use std::{
  collections::HashMap,
  sync::{Arc, Mutex},
  time::Duration,
};

use futures_util::StreamExt;
use reqwest::{
  Client,
  header::{ACCEPT, CONTENT_TYPE},
  redirect::Policy,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

const PROTOCOL_VERSION: u32 = 1;
const ANYSEARCH_ENDPOINT: &str = "https://api.anysearch.com/v1/search";
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_RESULTS: usize = 20;
const MIN_TIMEOUT_MS: u64 = 5_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ANSWER_BYTES: usize = 256 * 1024;
const MAX_SNIPPET_BYTES: usize = 64 * 1024;
const MAX_CONTENT_BYTES: usize = 256 * 1024;
const MAX_URL_BYTES: usize = 8 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct WebSearchService {
  inner: Arc<WebSearchServiceInner>,
}

struct WebSearchServiceInner {
  client: Client,
  active: Mutex<HashMap<String, CancellationToken>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeWebSearchExecuteRequest {
  protocol_version: u32,
  request_id: String,
  operation_id: String,
  kind: String,
  provider_id: String,
  query: String,
  num_results: usize,
  include_content: bool,
  timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeWebSearchCancelRequest {
  protocol_version: u32,
  request_id: String,
  operation_id: String,
  kind: String,
}

#[derive(Debug, Serialize)]
pub struct NativeWebSearchExecuteResponse {
  protocol_version: u32,
  request_id: String,
  operation_id: String,
  kind: &'static str,
  success: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  response: Option<WebSearchResponse>,
  #[serde(skip_serializing_if = "Option::is_none")]
  code: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NativeWebSearchCancelResponse {
  protocol_version: u32,
  request_id: String,
  operation_id: String,
  kind: &'static str,
  cancelled: bool,
}

#[derive(Debug, Serialize)]
struct WebSearchResponse {
  query: String,
  provider: &'static str,
  answer: String,
  sources: Vec<WebSearchSource>,
}

#[derive(Debug, Serialize)]
struct WebSearchSource {
  title: String,
  url: String,
  snippet: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnySearchEnvelope {
  code: i64,
  data: AnySearchData,
}

#[derive(Debug, Deserialize)]
struct AnySearchData {
  results: Vec<AnySearchResult>,
}

#[derive(Debug, Deserialize)]
struct AnySearchResult {
  title: String,
  url: String,
  snippet: String,
  content: String,
}

#[derive(Debug, Serialize)]
struct AnySearchRequestBody<'a> {
  query: &'a str,
  max_results: usize,
}

struct SearchFailure {
  code: &'static str,
  message: String,
}

impl WebSearchService {
  pub fn new() -> Result<Self, reqwest::Error> {
    let client = Client::builder()
      .redirect(Policy::none())
      .no_proxy()
      .connect_timeout(CONNECT_TIMEOUT)
      .build()?;
    Ok(Self {
      inner: Arc::new(WebSearchServiceInner {
        client,
        active: Mutex::new(HashMap::new()),
      }),
    })
  }

  fn start(&self, operation_id: &str) -> Result<CancellationToken, String> {
    let mut active = self
      .inner
      .active
      .lock()
      .map_err(|_| "The native web search registry is unavailable.".to_owned())?;
    if active.contains_key(operation_id) {
      return Err(format!(
        "Web search operation is already active: {operation_id}"
      ));
    }
    let cancellation = CancellationToken::new();
    active.insert(operation_id.to_owned(), cancellation.clone());
    Ok(cancellation)
  }

  fn finish(&self, operation_id: &str) {
    if let Ok(mut active) = self.inner.active.lock() {
      active.remove(operation_id);
    }
  }

  fn cancel(&self, operation_id: &str) -> Result<bool, String> {
    let cancellation = self
      .inner
      .active
      .lock()
      .map_err(|_| "The native web search registry is unavailable.".to_owned())?
      .get(operation_id)
      .cloned();
    if let Some(cancellation) = cancellation {
      cancellation.cancel();
      Ok(true)
    } else {
      Ok(false)
    }
  }

  async fn search_anysearch(
    &self,
    request: &NativeWebSearchExecuteRequest,
  ) -> Result<WebSearchResponse, SearchFailure> {
    let body = serde_json::to_string(&AnySearchRequestBody {
      query: &request.query,
      max_results: request.num_results,
    })
    .map_err(internal_failure)?;
    let response = self
      .inner
      .client
      .post(ANYSEARCH_ENDPOINT)
      .header(ACCEPT, "application/json")
      .header(CONTENT_TYPE, "application/json")
      .body(body)
      .send()
      .await
      .map_err(network_failure)?;
    let status = response.status();
    let bytes = read_bounded_response(response).await?;
    if !status.is_success() {
      return Err(SearchFailure {
        code: "provider",
        // Some quota responses can contain generated account credentials.
        // Never forward provider error bodies across the native boundary.
        message: format!("AnySearch API error {}.", status.as_u16()),
      });
    }
    let envelope: AnySearchEnvelope =
      serde_json::from_slice(&bytes).map_err(|error| SearchFailure {
        code: "provider",
        message: format!("AnySearch API returned invalid JSON: {error}"),
      })?;
    if envelope.code != 0 {
      return Err(SearchFailure {
        code: "provider",
        message: format!("AnySearch API returned error code {}.", envelope.code),
      });
    }
    let sources = envelope
      .data
      .results
      .into_iter()
      .take(request.num_results)
      .map(|result| WebSearchSource {
        title: truncate_utf8(&result.title, 2_048),
        url: result.url,
        snippet: truncate_utf8(&result.snippet, MAX_SNIPPET_BYTES),
        content: if request.include_content && !result.content.is_empty() {
          Some(truncate_utf8(&result.content, MAX_CONTENT_BYTES))
        } else {
          None
        },
      })
      .collect::<Vec<_>>();
    validate_source_urls(&sources)?;
    let answer = truncate_utf8(
      &sources
        .iter()
        .map(|source| {
          if source.snippet.is_empty() {
            format!("Source: {} ({})", source.title, source.url)
          } else {
            format!(
              "{}\nSource: {} ({})",
              source.snippet, source.title, source.url
            )
          }
        })
        .collect::<Vec<_>>()
        .join("\n\n"),
      MAX_ANSWER_BYTES,
    );
    Ok(WebSearchResponse {
      query: request.query.clone(),
      provider: "anysearch",
      answer,
      sources,
    })
  }
}

#[tauri::command]
pub async fn native_web_search_execute(
  web_search: tauri::State<'_, WebSearchService>,
  request: NativeWebSearchExecuteRequest,
) -> Result<NativeWebSearchExecuteResponse, ()> {
  if let Some(message) = validate_execute_request(&request) {
    return Ok(execute_error(&request, "invalid_request", message));
  }
  let service = web_search.inner().clone();
  let cancellation = match service.start(&request.operation_id) {
    Ok(cancellation) => cancellation,
    Err(message) => return Ok(execute_error(&request, "invalid_request", message)),
  };
  let timeout = tokio::time::sleep(Duration::from_millis(request.timeout_ms));
  tokio::pin!(timeout);
  let result = tokio::select! {
    () = cancellation.cancelled() => Err(SearchFailure {
      code: "aborted",
      message: "Web search was cancelled.".to_owned(),
    }),
    () = &mut timeout => Err(SearchFailure {
      code: "timeout",
      message: format!("Web search exceeded {} ms.", request.timeout_ms),
    }),
    result = service.search_anysearch(&request) => result,
  };
  service.finish(&request.operation_id);
  Ok(match result {
    Ok(response) => NativeWebSearchExecuteResponse {
      protocol_version: PROTOCOL_VERSION,
      request_id: request.request_id,
      operation_id: request.operation_id,
      kind: "web_search_execute_result",
      success: true,
      response: Some(response),
      code: None,
      message: None,
    },
    Err(failure) => execute_error(&request, failure.code, failure.message),
  })
}

#[tauri::command]
pub async fn native_web_search_cancel(
  web_search: tauri::State<'_, WebSearchService>,
  request: NativeWebSearchCancelRequest,
) -> Result<NativeWebSearchCancelResponse, ()> {
  let valid = request.protocol_version == PROTOCOL_VERSION
    && request.kind == "web_search_cancel"
    && valid_identifier(&request.request_id)
    && valid_identifier(&request.operation_id);
  let cancelled = valid && web_search.cancel(&request.operation_id).unwrap_or(false);
  Ok(NativeWebSearchCancelResponse {
    protocol_version: PROTOCOL_VERSION,
    request_id: request.request_id,
    operation_id: request.operation_id,
    kind: "web_search_cancel_result",
    cancelled,
  })
}

fn validate_execute_request(request: &NativeWebSearchExecuteRequest) -> Option<String> {
  if request.protocol_version != PROTOCOL_VERSION {
    return Some(format!(
      "Unsupported native web search protocol version: {}.",
      request.protocol_version
    ));
  }
  if request.kind != "web_search_execute" || request.provider_id != "anysearch" {
    return Some("Invalid native web search kind or provider.".to_owned());
  }
  if !valid_identifier(&request.request_id) || !valid_identifier(&request.operation_id) {
    return Some("request_id and operation_id are invalid.".to_owned());
  }
  if request.query.trim().is_empty() || request.query.len() > MAX_QUERY_BYTES {
    return Some("Web search query is out of bounds.".to_owned());
  }
  if request.num_results == 0 || request.num_results > MAX_RESULTS {
    return Some("Web search result count is out of bounds.".to_owned());
  }
  if request.timeout_ms < MIN_TIMEOUT_MS || request.timeout_ms > MAX_TIMEOUT_MS {
    return Some("Web search timeout is out of bounds.".to_owned());
  }
  None
}

async fn read_bounded_response(response: reqwest::Response) -> Result<Vec<u8>, SearchFailure> {
  if response
    .content_length()
    .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
  {
    return Err(SearchFailure {
      code: "provider",
      message: "AnySearch API response exceeds the size limit.".to_owned(),
    });
  }
  let mut bytes = Vec::new();
  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(network_failure)?;
    if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
      return Err(SearchFailure {
        code: "provider",
        message: "AnySearch API response exceeds the size limit.".to_owned(),
      });
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(bytes)
}

fn validate_source_urls(sources: &[WebSearchSource]) -> Result<(), SearchFailure> {
  for source in sources {
    if source.url.len() > MAX_URL_BYTES {
      return Err(SearchFailure {
        code: "provider",
        message: "AnySearch API returned an oversized source URL.".to_owned(),
      });
    }
    let parsed = reqwest::Url::parse(&source.url).map_err(|_| SearchFailure {
      code: "provider",
      message: "AnySearch API returned an invalid source URL.".to_owned(),
    })?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
      return Err(SearchFailure {
        code: "provider",
        message: "AnySearch API returned a non-HTTP source URL.".to_owned(),
      });
    }
  }
  Ok(())
}

fn execute_error(
  request: &NativeWebSearchExecuteRequest,
  code: &'static str,
  message: String,
) -> NativeWebSearchExecuteResponse {
  NativeWebSearchExecuteResponse {
    protocol_version: PROTOCOL_VERSION,
    request_id: request.request_id.clone(),
    operation_id: request.operation_id.clone(),
    kind: "web_search_execute_result",
    success: false,
    response: None,
    code: Some(code),
    message: Some(truncate_utf8(&message, 1_000)),
  }
}

fn valid_identifier(value: &str) -> bool {
  !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES
}

fn truncate_utf8(value: &str, maximum_bytes: usize) -> String {
  if value.len() <= maximum_bytes {
    return value.to_owned();
  }
  let mut end = maximum_bytes;
  while !value.is_char_boundary(end) {
    end -= 1;
  }
  value[..end].to_owned()
}

fn network_failure(error: reqwest::Error) -> SearchFailure {
  SearchFailure {
    code: if error.is_timeout() {
      "timeout"
    } else {
      "network"
    },
    message: format!("AnySearch network error: {error}"),
  }
}

fn internal_failure(error: serde_json::Error) -> SearchFailure {
  SearchFailure {
    code: "internal",
    message: format!("Could not encode the AnySearch request: {error}"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn valid_request() -> NativeWebSearchExecuteRequest {
    NativeWebSearchExecuteRequest {
      protocol_version: PROTOCOL_VERSION,
      request_id: "request-1".to_owned(),
      operation_id: "operation-1".to_owned(),
      kind: "web_search_execute".to_owned(),
      provider_id: "anysearch".to_owned(),
      query: "rust wasm".to_owned(),
      num_results: 5,
      include_content: false,
      timeout_ms: 20_000,
    }
  }

  #[test]
  fn validates_fixed_provider_request_bounds() {
    assert!(validate_execute_request(&valid_request()).is_none());
    let mut invalid = valid_request();
    invalid.provider_id = "other".to_owned();
    assert!(validate_execute_request(&invalid).is_some());
    let mut invalid = valid_request();
    invalid.query = "x".repeat(MAX_QUERY_BYTES + 1);
    assert!(validate_execute_request(&invalid).is_some());
    let mut invalid = valid_request();
    invalid.num_results = MAX_RESULTS + 1;
    assert!(validate_execute_request(&invalid).is_some());
  }

  #[test]
  fn truncates_utf8_only_at_character_boundaries() {
    assert_eq!(truncate_utf8("abc", 3), "abc");
    assert_eq!(truncate_utf8("a好b", 3), "a");
    assert_eq!(truncate_utf8("a好b", 4), "a好");
  }

  #[test]
  fn rejects_non_http_source_urls() {
    let result = validate_source_urls(&[WebSearchSource {
      title: "Local".to_owned(),
      url: "file:///tmp/private".to_owned(),
      snippet: String::new(),
      content: None,
    }]);
    assert!(result.is_err());
  }
}
