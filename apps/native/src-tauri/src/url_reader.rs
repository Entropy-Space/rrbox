use std::{
  collections::HashMap,
  net::{IpAddr, SocketAddr},
  sync::{Arc, Mutex},
  time::Duration,
};

use futures_util::StreamExt;
use reqwest::{
  Client, Url,
  header::{ACCEPT, CONTENT_TYPE, LOCATION},
  redirect::Policy,
};
use serde::{Deserialize, Serialize};
use tokio::{net::lookup_host, time::sleep};
use tokio_util::sync::CancellationToken;

const PROTOCOL_VERSION: u32 = 1;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_URL_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MIN_TIMEOUT_MS: u64 = 5_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_REDIRECTS: usize = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct UrlReaderService {
  inner: Arc<UrlReaderServiceInner>,
}

struct UrlReaderServiceInner {
  active: Mutex<HashMap<String, CancellationToken>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeUrlReaderOpenRequest {
  protocol_version: u32,
  request_id: String,
  operation_id: String,
  kind: String,
  url: String,
  format: String,
  timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeUrlReaderCancelRequest {
  protocol_version: u32,
  request_id: String,
  operation_id: String,
  kind: String,
}

#[derive(Debug, Serialize)]
pub struct NativeUrlReaderOpenResponse {
  protocol_version: u32,
  request_id: String,
  operation_id: String,
  kind: &'static str,
  success: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  result: Option<NativeUrlReaderResult>,
  #[serde(skip_serializing_if = "Option::is_none")]
  code: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NativeUrlReaderCancelResponse {
  protocol_version: u32,
  request_id: String,
  operation_id: String,
  kind: &'static str,
  cancelled: bool,
}

#[derive(Debug, Serialize)]
struct NativeUrlReaderResult {
  requested_url: String,
  final_url: String,
  status: u16,
  content_type: String,
  content: String,
}

struct UrlReaderFailure {
  code: &'static str,
  message: String,
}

impl UrlReaderService {
  pub fn new() -> Self {
    Self {
      inner: Arc::new(UrlReaderServiceInner {
        active: Mutex::new(HashMap::new()),
      }),
    }
  }

  fn start(&self, operation_id: &str) -> Result<CancellationToken, String> {
    let mut active = self
      .inner
      .active
      .lock()
      .map_err(|_| "The native URL reader registry is unavailable.".to_owned())?;
    if active.contains_key(operation_id) {
      return Err(format!(
        "URL reader operation is already active: {operation_id}"
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
      .map_err(|_| "The native URL reader registry is unavailable.".to_owned())?
      .get(operation_id)
      .cloned();
    if let Some(cancellation) = cancellation {
      cancellation.cancel();
      Ok(true)
    } else {
      Ok(false)
    }
  }

  async fn open(
    &self,
    request: &NativeUrlReaderOpenRequest,
  ) -> Result<NativeUrlReaderResult, UrlReaderFailure> {
    let requested_url = parse_public_url(&request.url)?;
    let mut current_url = requested_url.clone();
    for _ in 0..=MAX_REDIRECTS {
      let client = client_for_url(&current_url).await?;
      let response = client
        .get(current_url.clone())
        .header(ACCEPT, accept_header(&request.format))
        .send()
        .await
        .map_err(network_failure)?;
      if response.status().is_redirection() {
        current_url = redirect_target(&current_url, &response)?;
        continue;
      }
      if !response.status().is_success() {
        return Err(UrlReaderFailure {
          code: "network",
          message: format!("URL request failed with HTTP {}.", response.status()),
        });
      }
      let content_type = content_type(&response);
      assert_text_response(&content_type, &request.format)?;
      let status = response.status().as_u16();
      let bytes = read_bounded_response(response).await?;
      let content = String::from_utf8_lossy(&bytes).into_owned();
      if content.trim().is_empty() {
        return Err(UrlReaderFailure {
          code: "unsupported",
          message: "The URL returned an empty response.".to_owned(),
        });
      }
      return Ok(NativeUrlReaderResult {
        requested_url: requested_url.to_string(),
        final_url: current_url.to_string(),
        status,
        content_type: if content_type.is_empty() {
          "text/plain".to_owned()
        } else {
          content_type
        },
        content,
      });
    }
    Err(UrlReaderFailure {
      code: "network",
      message: format!("URL exceeded the {MAX_REDIRECTS} redirect limit."),
    })
  }
}

#[tauri::command]
pub async fn native_url_reader_open(
  url_reader: tauri::State<'_, UrlReaderService>,
  request: NativeUrlReaderOpenRequest,
) -> Result<NativeUrlReaderOpenResponse, ()> {
  if let Some(message) = validate_open_request(&request) {
    return Ok(open_error(&request, "invalid_request", message));
  }
  let service = url_reader.inner().clone();
  let cancellation = match service.start(&request.operation_id) {
    Ok(cancellation) => cancellation,
    Err(message) => return Ok(open_error(&request, "invalid_request", message)),
  };
  let timeout = sleep(Duration::from_millis(request.timeout_ms));
  tokio::pin!(timeout);
  let result = tokio::select! {
    () = cancellation.cancelled() => Err(UrlReaderFailure {
      code: "aborted",
      message: "URL opening was cancelled.".to_owned(),
    }),
    () = &mut timeout => Err(UrlReaderFailure {
      code: "timeout",
      message: format!("URL opening exceeded {} ms.", request.timeout_ms),
    }),
    result = service.open(&request) => result,
  };
  service.finish(&request.operation_id);
  Ok(match result {
    Ok(result) => NativeUrlReaderOpenResponse {
      protocol_version: PROTOCOL_VERSION,
      request_id: request.request_id,
      operation_id: request.operation_id,
      kind: "url_reader_open_result",
      success: true,
      result: Some(result),
      code: None,
      message: None,
    },
    Err(failure) => open_error(&request, failure.code, failure.message),
  })
}

#[tauri::command]
pub async fn native_url_reader_cancel(
  url_reader: tauri::State<'_, UrlReaderService>,
  request: NativeUrlReaderCancelRequest,
) -> Result<NativeUrlReaderCancelResponse, ()> {
  let valid = request.protocol_version == PROTOCOL_VERSION
    && request.kind == "url_reader_cancel"
    && valid_identifier(&request.request_id)
    && valid_identifier(&request.operation_id);
  let cancelled = valid && url_reader.cancel(&request.operation_id).unwrap_or(false);
  Ok(NativeUrlReaderCancelResponse {
    protocol_version: PROTOCOL_VERSION,
    request_id: request.request_id,
    operation_id: request.operation_id,
    kind: "url_reader_cancel_result",
    cancelled,
  })
}

fn validate_open_request(request: &NativeUrlReaderOpenRequest) -> Option<String> {
  if request.protocol_version != PROTOCOL_VERSION || request.kind != "url_reader_open" {
    return Some("Invalid native URL reader protocol or request kind.".to_owned());
  }
  if !valid_identifier(&request.request_id) || !valid_identifier(&request.operation_id) {
    return Some("request_id and operation_id are invalid.".to_owned());
  }
  if request.url.is_empty() || request.url.len() > MAX_URL_BYTES {
    return Some("URL is out of bounds.".to_owned());
  }
  if request.format != "html" && request.format != "markdown" {
    return Some("URL reader format is invalid.".to_owned());
  }
  if request.timeout_ms < MIN_TIMEOUT_MS || request.timeout_ms > MAX_TIMEOUT_MS {
    return Some("URL reader timeout is out of bounds.".to_owned());
  }
  None
}

fn parse_public_url(value: &str) -> Result<Url, UrlReaderFailure> {
  let url = Url::parse(value).map_err(|_| UrlReaderFailure {
    code: "invalid_request",
    message: "URL must be a valid HTTP or HTTPS address.".to_owned(),
  })?;
  if url.scheme() != "http" && url.scheme() != "https" {
    return Err(UrlReaderFailure {
      code: "invalid_request",
      message: "URL must use HTTP or HTTPS.".to_owned(),
    });
  }
  if !url.username().is_empty() || url.password().is_some() {
    return Err(UrlReaderFailure {
      code: "invalid_request",
      message: "URLs with embedded credentials are not supported.".to_owned(),
    });
  }
  let host = url.host_str().ok_or_else(|| UrlReaderFailure {
    code: "invalid_request",
    message: "URL must use a public hostname.".to_owned(),
  })?;
  if is_blocked_hostname(host) {
    return Err(UrlReaderFailure {
      code: "invalid_request",
      message: "URL must use a public hostname.".to_owned(),
    });
  }
  if let Ok(address) = host.parse::<IpAddr>() {
    if !is_public_ip(address) {
      return Err(UrlReaderFailure {
        code: "invalid_request",
        message: "URL must use a public hostname.".to_owned(),
      });
    }
  }
  Ok(url)
}

async fn client_for_url(url: &Url) -> Result<Client, UrlReaderFailure> {
  let host = url.host_str().ok_or_else(|| UrlReaderFailure {
    code: "invalid_request",
    message: "URL must use a public hostname.".to_owned(),
  })?;
  let mut builder = Client::builder()
    .redirect(Policy::none())
    .no_proxy()
    .connect_timeout(CONNECT_TIMEOUT);
  if host.parse::<IpAddr>().is_err() {
    let port = url
      .port_or_known_default()
      .ok_or_else(|| UrlReaderFailure {
        code: "invalid_request",
        message: "URL must use a supported port.".to_owned(),
      })?;
    let addresses = lookup_host((host, port))
      .await
      .map_err(dns_failure)?
      .filter(|address| is_public_ip(address.ip()))
      .collect::<Vec<SocketAddr>>();
    if addresses.is_empty() {
      return Err(UrlReaderFailure {
        code: "invalid_request",
        message: "URL must resolve to a public address.".to_owned(),
      });
    }
    builder = builder.resolve_to_addrs(host, &addresses);
  }
  builder.build().map_err(|error| UrlReaderFailure {
    code: "internal",
    message: format!("Could not create URL reader client: {error}"),
  })
}

fn redirect_target(url: &Url, response: &reqwest::Response) -> Result<Url, UrlReaderFailure> {
  let location = response
    .headers()
    .get(LOCATION)
    .ok_or_else(|| UrlReaderFailure {
      code: "network",
      message: "URL redirect did not include a location.".to_owned(),
    })?
    .to_str()
    .map_err(|_| UrlReaderFailure {
      code: "network",
      message: "URL redirect included an invalid location.".to_owned(),
    })?;
  let target = url.join(location).map_err(|_| UrlReaderFailure {
    code: "network",
    message: "URL redirect included an invalid location.".to_owned(),
  })?;
  parse_public_url(target.as_str())
}

fn content_type(response: &reqwest::Response) -> String {
  response
    .headers()
    .get(CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.split(';').next())
    .map(|value| value.trim().to_ascii_lowercase())
    .unwrap_or_default()
}

fn assert_text_response(content_type: &str, format: &str) -> Result<(), UrlReaderFailure> {
  if format == "html" && !is_html_content_type(content_type) {
    return Err(UrlReaderFailure {
      code: "unsupported",
      message: format!(
        "URL returned {}, not HTML.",
        if content_type.is_empty() {
          "an unknown content type"
        } else {
          content_type
        }
      ),
    });
  }
  if !content_type.is_empty()
    && !content_type.starts_with("text/")
    && content_type != "application/json"
    && !content_type.ends_with("+json")
    && content_type != "application/xml"
    && !content_type.ends_with("+xml")
  {
    return Err(UrlReaderFailure {
      code: "unsupported",
      message: format!("Unsupported URL content type: {content_type}."),
    });
  }
  Ok(())
}

async fn read_bounded_response(response: reqwest::Response) -> Result<Vec<u8>, UrlReaderFailure> {
  if response
    .content_length()
    .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
  {
    return Err(UrlReaderFailure {
      code: "unsupported",
      message: "URL response exceeded the 2 MB limit.".to_owned(),
    });
  }
  let mut bytes = Vec::new();
  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(network_failure)?;
    if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
      return Err(UrlReaderFailure {
        code: "unsupported",
        message: "URL response exceeded the 2 MB limit.".to_owned(),
      });
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(bytes)
}

fn accept_header(format: &str) -> &'static str {
  if format == "html" {
    "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5"
  } else {
    "text/markdown, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7"
  }
}

fn is_html_content_type(content_type: &str) -> bool {
  content_type == "text/html" || content_type == "application/xhtml+xml"
}

fn is_blocked_hostname(host: &str) -> bool {
  let normalized = host.to_ascii_lowercase();
  normalized == "localhost"
    || normalized.ends_with(".localhost")
    || normalized.ends_with(".local")
    || normalized.contains(':')
}

fn is_public_ip(address: IpAddr) -> bool {
  match address {
    IpAddr::V4(address) => {
      let [first, second, third, _] = address.octets();
      first != 0
        && first != 10
        && first != 127
        && first < 224
        && !(first == 100 && (64..=127).contains(&second))
        && !(first == 169 && second == 254)
        && !(first == 172 && (16..=31).contains(&second))
        && !(first == 192 && (second == 0 || second == 88 || second == 168))
        && !(first == 198 && (second == 18 || second == 19 || second == 51))
        && !(first == 203 && second == 0 && third == 113)
    }
    // Direct IPv6 URL support needs an IPv6 policy and resolver binding.
    // Keep it disabled until both are implemented.
    IpAddr::V6(_) => false,
  }
}

fn open_error(
  request: &NativeUrlReaderOpenRequest,
  code: &'static str,
  message: String,
) -> NativeUrlReaderOpenResponse {
  NativeUrlReaderOpenResponse {
    protocol_version: PROTOCOL_VERSION,
    request_id: request.request_id.clone(),
    operation_id: request.operation_id.clone(),
    kind: "url_reader_open_result",
    success: false,
    result: None,
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

fn network_failure(error: reqwest::Error) -> UrlReaderFailure {
  UrlReaderFailure {
    code: if error.is_timeout() {
      "timeout"
    } else {
      "network"
    },
    message: format!("URL request failed: {error}"),
  }
}

fn dns_failure(error: std::io::Error) -> UrlReaderFailure {
  UrlReaderFailure {
    code: "network",
    message: format!("URL hostname lookup failed: {error}"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn validates_public_url_forms() {
    assert!(parse_public_url("https://example.com/path").is_ok());
    for url in [
      "http://localhost/",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://192.168.0.1/",
      "http://[::1]/",
      "https://user:secret@example.com/",
      "file:///tmp/file",
    ] {
      assert!(parse_public_url(url).is_err(), "{url}");
    }
  }

  #[test]
  fn recognizes_supported_text_content_types() {
    assert!(assert_text_response("text/html", "html").is_ok());
    assert!(assert_text_response("application/json", "markdown").is_ok());
    assert!(assert_text_response("image/png", "markdown").is_err());
    assert!(assert_text_response("text/plain", "html").is_err());
  }
}
