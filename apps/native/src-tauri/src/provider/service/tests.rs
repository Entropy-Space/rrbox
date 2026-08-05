use std::{
  collections::BTreeMap,
  io::{self, Read, Write},
  net::{TcpListener, TcpStream},
  sync::mpsc,
  thread,
  time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};

use super::{MAX_REQUEST_BYTES, ProviderService, ProviderServiceError};
use crate::provider::protocol::{
  LOCAL_OPENAI_PROVIDER_ID, NATIVE_PROVIDER_PROTOCOL_VERSION, NativeProviderBodyEvent,
  NativeProviderBodyEventPayload, NativeProviderBodyStatus, NativeProviderCancelRequest,
  NativeProviderEndpoint, NativeProviderFetchRequest, NativeProviderMethod,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(2);

#[test]
fn rejects_routes_methods_providers_and_oversized_bodies_before_networking() {
  let service = test_service("http://127.0.0.1:1/v1");

  let cases = [
    fetch_request(
      "wrong-provider",
      NativeProviderEndpoint::Models,
      NativeProviderMethod::Get,
      None,
    ),
    fetch_request(
      LOCAL_OPENAI_PROVIDER_ID,
      NativeProviderEndpoint::Models,
      NativeProviderMethod::Post,
      Some("{}".into()),
    ),
    fetch_request(
      LOCAL_OPENAI_PROVIDER_ID,
      NativeProviderEndpoint::ChatCompletions,
      NativeProviderMethod::Get,
      None,
    ),
    fetch_request(
      LOCAL_OPENAI_PROVIDER_ID,
      NativeProviderEndpoint::ChatCompletions,
      NativeProviderMethod::Post,
      Some("[]".into()),
    ),
  ];

  for (index, request) in cases.into_iter().enumerate() {
    let error = service
      .start_fetch(request, |_| Ok(()))
      .expect_err("invalid provider request must be rejected");
    assert_eq!(
      error.code(),
      if index == 0 {
        "provider_unavailable"
      } else {
        "invalid_request"
      }
    );
  }

  let oversized = "x".repeat(MAX_REQUEST_BYTES + 1);
  let error = service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::ChatCompletions,
        NativeProviderMethod::Post,
        Some(oversized),
      ),
      |_| Ok(()),
    )
    .expect_err("oversized request body must be rejected");
  assert!(error.to_string().contains("too large"));
  assert_eq!(service.active_operation_count(), 0);
}

#[test]
fn uses_only_the_fixed_endpoint_path_and_method() {
  let server = TestServer::spawn(|mut stream| {
    write_response(
      &mut stream,
      "200 OK",
      &[("content-type", "application/json")],
      br#"{"data":[]}"#,
    );
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();

  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      move |event| sender.send(event).map_err(|_| ()),
    )
    .expect("start models request");

  let events = collect_events(&receiver);
  assert_complete(&events);
  let request = server.request();
  assert_eq!(request.request_line, "GET /v1/models HTTP/1.1");
  assert_eq!(request.body, b"");
}

#[test]
fn forwards_chat_json_only_to_the_fixed_chat_completions_path() {
  let server = TestServer::spawn(|mut stream| {
    write_response(
      &mut stream,
      "200 OK",
      &[("content-type", "text/event-stream")],
      b"data: [DONE]\n\n",
    );
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();
  let request_body = r#"{"model":"test-model","stream":true}"#;

  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::ChatCompletions,
        NativeProviderMethod::Post,
        Some(request_body.into()),
      ),
      move |event| sender.send(event).map_err(|_| ()),
    )
    .expect("start chat request");

  assert_complete(&collect_events(&receiver));
  let request = server.request();
  assert_eq!(request.request_line, "POST /v1/chat/completions HTTP/1.1");
  assert_eq!(request.body, request_body.as_bytes());
}

#[test]
fn forwards_session_affinity_headers_to_chat_completions() {
  let server = TestServer::spawn(|mut stream| {
    write_response(
      &mut stream,
      "200 OK",
      &[("content-type", "text/event-stream")],
      b"data: [DONE]\n\n",
    );
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();
  let request_body = r#"{"model":"test-model","stream":true}"#;
  let mut request = fetch_request(
    LOCAL_OPENAI_PROVIDER_ID,
    NativeProviderEndpoint::ChatCompletions,
    NativeProviderMethod::Post,
    Some(request_body.into()),
  );
  request.session_affinity_headers = BTreeMap::from([
    ("session_id".into(), "session-1".into()),
    ("x-client-request-id".into(), "session-1".into()),
    ("x-session-affinity".into(), "session-1".into()),
  ]);

  service
    .start_fetch(request, move |event| sender.send(event).map_err(|_| ()))
    .expect("start chat request");

  assert_complete(&collect_events(&receiver));
  let request = server.request();
  assert_eq!(request.header("session_id"), Some("session-1"));
  assert_eq!(request.header("x-client-request-id"), Some("session-1"));
  assert_eq!(request.header("x-session-affinity"), Some("session-1"));
}

#[test]
fn does_not_follow_provider_redirects() {
  let server = TestServer::spawn(|mut stream| {
    write_response(
      &mut stream,
      "302 Found",
      &[("location", "http://127.0.0.1:9/escape")],
      b"",
    );
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();
  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      move |event| sender.send(event).map_err(|_| ()),
    )
    .expect("start request");

  let events = collect_events(&receiver);
  assert!(matches!(
    events.first().map(|event| &event.payload),
    Some(NativeProviderBodyEventPayload::ResponseStarted { status: 302, .. })
  ));
  assert_complete(&events);
}

#[test]
fn rejects_a_duplicate_operation_without_replacing_the_active_request() {
  let server = TestServer::spawn(|mut stream| {
    write!(
      stream,
      "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\
       transfer-encoding: chunked\r\n\r\n"
    )
    .expect("write response headers");
    stream.flush().expect("flush response headers");
    thread::sleep(Duration::from_millis(300));
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();
  let request = fetch_request(
    LOCAL_OPENAI_PROVIDER_ID,
    NativeProviderEndpoint::Models,
    NativeProviderMethod::Get,
    None,
  );

  service
    .start_fetch(request, move |event| sender.send(event).map_err(|_| ()))
    .expect("start first request");
  let duplicate = service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      |_| Ok(()),
    )
    .expect_err("duplicate operation must be rejected");
  assert!(matches!(duplicate, ProviderServiceError::InvalidRequest(_)));

  assert!(service.cancel(&cancel_request()).expect("cancel operation"));
  let events = collect_events(&receiver);
  assert_terminal_status(&events, NativeProviderBodyStatus::Aborted);
}

#[test]
fn cancellation_is_race_safe_idempotent_and_cleans_up_registry_state() {
  let server = TestServer::spawn(|mut stream| {
    thread::sleep(Duration::from_millis(300));
    let _ = try_write_response(&mut stream, "200 OK", &[], b"late");
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();
  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      move |event| sender.send(event).map_err(|_| ()),
    )
    .expect("start request");

  assert!(
    service
      .cancel(&cancel_request())
      .expect("cancel active request")
  );
  let events = collect_events(&receiver);
  assert_terminal_status(&events, NativeProviderBodyStatus::Aborted);
  wait_for_cleanup(&service);
  assert!(
    !service
      .cancel(&cancel_request())
      .expect("repeat cancellation")
  );
}

#[test]
fn reports_timeout_before_response_metadata_and_cleans_up() {
  let server = TestServer::spawn(|mut stream| {
    thread::sleep(Duration::from_millis(200));
    let _ = try_write_response(&mut stream, "200 OK", &[], b"late");
  });
  let service = ProviderService::new_for_test(
    server.base_url.clone(),
    Duration::from_millis(40),
    Duration::from_millis(40),
  );
  let (sender, receiver) = mpsc::channel();
  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      move |event| sender.send(event).map_err(|_| ()),
    )
    .expect("start request");

  let events = collect_events(&receiver);
  assert_eq!(events.len(), 1);
  assert_terminal_status(&events, NativeProviderBodyStatus::Error);
  match &events[0].payload {
    NativeProviderBodyEventPayload::BodyFinished {
      error_message: Some(message),
      ..
    } => assert!(message.contains("timed out")),
    payload => panic!("unexpected timeout payload: {payload:?}"),
  }
  wait_for_cleanup(&service);
}

#[test]
fn preserves_non_success_status_content_type_and_bounded_body() {
  let server = TestServer::spawn(|mut stream| {
    write_response(
      &mut stream,
      "429 Too Many Requests",
      &[
        ("content-type", "application/json"),
        ("x-request-id", "upstream-42"),
        ("set-cookie", "must-not-cross-the-bridge"),
      ],
      br#"{"error":{"message":"rate limited"}}"#,
    );
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();
  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      move |event| sender.send(event).map_err(|_| ()),
    )
    .expect("start request");

  let events = collect_events(&receiver);
  match &events[0].payload {
    NativeProviderBodyEventPayload::ResponseStarted {
      status,
      status_text,
      headers,
    } => {
      assert_eq!(*status, 429);
      assert_eq!(status_text, "Too Many Requests");
      assert_eq!(
        headers.get("content-type").map(String::as_str),
        Some("application/json")
      );
      assert_eq!(
        headers.get("x-request-id").map(String::as_str),
        Some("upstream-42")
      );
      assert!(!headers.contains_key("set-cookie"));
    }
    payload => panic!("unexpected first response event: {payload:?}"),
  }
  assert_eq!(
    decoded_body(&events),
    br#"{"error":{"message":"rate limited"}}"#
  );
  assert_complete(&events);
}

#[test]
fn preserves_chunk_order_with_monotonic_indices() {
  let server = TestServer::spawn(|mut stream| {
    write!(
      stream,
      "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\
       transfer-encoding: chunked\r\n\r\n"
    )
    .expect("write response headers");
    for chunk in [b"data: one\n\n".as_slice(), b"data: two\n\n".as_slice()] {
      write!(stream, "{:x}\r\n", chunk.len()).expect("write chunk size");
      stream.write_all(chunk).expect("write response chunk");
      stream.write_all(b"\r\n").expect("write chunk suffix");
      stream.flush().expect("flush response chunk");
      thread::sleep(Duration::from_millis(20));
    }
    stream.write_all(b"0\r\n\r\n").expect("finish chunks");
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();
  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      move |event| sender.send(event).map_err(|_| ()),
    )
    .expect("start request");

  let events = collect_events(&receiver);
  for (index, event) in events.iter().enumerate() {
    assert_eq!(event.event_index, index as u64);
    assert_eq!(event.operation_id, "operation-1");
    assert_eq!(event.protocol_version, NATIVE_PROVIDER_PROTOCOL_VERSION);
  }
  assert_eq!(decoded_body(&events), b"data: one\n\ndata: two\n\n");
  assert_complete(&events);
}

#[test]
fn rejects_oversized_declared_responses_after_metadata() {
  let server = TestServer::spawn(|mut stream| {
    write!(
      stream,
      "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n",
      super::MAX_RESPONSE_BYTES + 1
    )
    .expect("write oversized response");
    stream.flush().expect("flush oversized response");
  });
  let service = test_service(&server.base_url);
  let (sender, receiver) = mpsc::channel();
  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      move |event| sender.send(event).map_err(|_| ()),
    )
    .expect("start request");

  let events = collect_events(&receiver);
  assert_eq!(events.len(), 2);
  assert!(matches!(
    events[0].payload,
    NativeProviderBodyEventPayload::ResponseStarted { .. }
  ));
  assert_terminal_status(&events, NativeProviderBodyStatus::Error);
}

#[test]
fn channel_failure_stops_delivery_and_cleans_up_the_operation() {
  let server = TestServer::spawn(|mut stream| {
    write_response(&mut stream, "200 OK", &[], b"ignored");
  });
  let service = test_service(&server.base_url);
  service
    .start_fetch(
      fetch_request(
        LOCAL_OPENAI_PROVIDER_ID,
        NativeProviderEndpoint::Models,
        NativeProviderMethod::Get,
        None,
      ),
      |_| Err(()),
    )
    .expect("start request");

  wait_for_cleanup(&service);
}

fn fetch_request(
  provider_id: &str,
  endpoint: NativeProviderEndpoint,
  method: NativeProviderMethod,
  body: Option<String>,
) -> NativeProviderFetchRequest {
  NativeProviderFetchRequest {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    request_id: "request-1".into(),
    operation_id: "operation-1".into(),
    provider_id: provider_id.into(),
    endpoint,
    method,
    body,
    session_affinity_headers: BTreeMap::new(),
  }
}

fn cancel_request() -> NativeProviderCancelRequest {
  NativeProviderCancelRequest {
    protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
    request_id: "cancel-1".into(),
    operation_id: "operation-1".into(),
  }
}

fn test_service(base_url: &str) -> ProviderService {
  ProviderService::new_for_test(base_url.into(), TEST_TIMEOUT, TEST_TIMEOUT)
}

fn collect_events(
  receiver: &mpsc::Receiver<NativeProviderBodyEvent>,
) -> Vec<NativeProviderBodyEvent> {
  let mut events = Vec::new();
  loop {
    let event = receiver
      .recv_timeout(TEST_TIMEOUT)
      .expect("receive provider body event");
    let finished = matches!(
      event.payload,
      NativeProviderBodyEventPayload::BodyFinished { .. }
    );
    events.push(event);
    if finished {
      return events;
    }
  }
}

fn decoded_body(events: &[NativeProviderBodyEvent]) -> Vec<u8> {
  events
    .iter()
    .flat_map(|event| match &event.payload {
      NativeProviderBodyEventPayload::BodyChunk { chunk_base64 } => BASE64_STANDARD
        .decode(chunk_base64)
        .expect("decode provider body chunk"),
      _ => Vec::new(),
    })
    .collect()
}

fn assert_complete(events: &[NativeProviderBodyEvent]) {
  assert_terminal_status(events, NativeProviderBodyStatus::Complete);
}

fn assert_terminal_status(events: &[NativeProviderBodyEvent], expected: NativeProviderBodyStatus) {
  match &events.last().expect("terminal event").payload {
    NativeProviderBodyEventPayload::BodyFinished { status, .. } => {
      assert_eq!(*status, expected);
    }
    payload => panic!("expected terminal event, received {payload:?}"),
  }
}

fn wait_for_cleanup(service: &ProviderService) {
  let deadline = Instant::now() + TEST_TIMEOUT;
  while service.active_operation_count() != 0 {
    assert!(
      Instant::now() < deadline,
      "provider operation registry did not clean up"
    );
    thread::sleep(Duration::from_millis(5));
  }
}

#[derive(Debug)]
struct CapturedRequest {
  request_line: String,
  headers: BTreeMap<String, String>,
  body: Vec<u8>,
}

struct TestServer {
  base_url: String,
  request_receiver: mpsc::Receiver<CapturedRequest>,
  thread: Option<thread::JoinHandle<()>>,
}

impl TestServer {
  fn spawn(handler: impl FnOnce(TcpStream) + Send + 'static) -> Self {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    listener
      .set_nonblocking(true)
      .expect("make test server nonblocking");
    let address = listener.local_addr().expect("read test server address");
    let (request_sender, request_receiver) = mpsc::channel();
    let server_thread = thread::spawn(move || {
      let deadline = Instant::now() + TEST_TIMEOUT;
      let (mut stream, _) = loop {
        match listener.accept() {
          Ok(connection) => break connection,
          Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            if Instant::now() >= deadline {
              return;
            }
            thread::sleep(Duration::from_millis(5));
          }
          Err(error) => panic!("accept test request: {error}"),
        }
      };
      stream
        .set_nonblocking(false)
        .expect("make test connection blocking");
      let request = read_request(&mut stream);
      request_sender.send(request).expect("capture test request");
      handler(stream);
    });
    Self {
      base_url: format!("http://{address}/v1"),
      request_receiver,
      thread: Some(server_thread),
    }
  }

  fn request(&self) -> CapturedRequest {
    self
      .request_receiver
      .recv_timeout(TEST_TIMEOUT)
      .expect("receive captured request")
  }
}

impl CapturedRequest {
  fn header(&self, name: &str) -> Option<&str> {
    self
      .headers
      .get(&name.to_ascii_lowercase())
      .map(String::as_str)
  }
}

impl Drop for TestServer {
  fn drop(&mut self) {
    if let Some(handle) = self.thread.take() {
      handle.join().expect("join test server");
    }
  }
}

fn read_request(stream: &mut TcpStream) -> CapturedRequest {
  stream
    .set_read_timeout(Some(TEST_TIMEOUT))
    .expect("set request read timeout");
  let mut bytes = Vec::new();
  let mut buffer = [0_u8; 4096];
  let header_end = loop {
    let count = stream.read(&mut buffer).expect("read request");
    assert!(count > 0, "request ended before headers");
    bytes.extend_from_slice(&buffer[..count]);
    if let Some(index) = find_bytes(&bytes, b"\r\n\r\n") {
      break index + 4;
    }
  };
  let headers = String::from_utf8(bytes[..header_end].to_vec()).expect("request headers are UTF-8");
  let parsed_headers = headers
    .lines()
    .skip(1)
    .filter_map(|line| {
      let (name, value) = line.split_once(':')?;
      Some((name.to_ascii_lowercase(), value.trim().to_owned()))
    })
    .collect();
  let content_length = headers
    .lines()
    .find_map(|line| {
      let (name, value) = line.split_once(':')?;
      name
        .eq_ignore_ascii_case("content-length")
        .then(|| value.trim().parse::<usize>().expect("content length"))
    })
    .unwrap_or(0);
  while bytes.len() - header_end < content_length {
    let count = stream.read(&mut buffer).expect("read request body");
    assert!(count > 0, "request ended before body");
    bytes.extend_from_slice(&buffer[..count]);
  }
  CapturedRequest {
    request_line: headers.lines().next().expect("request line").into(),
    headers: parsed_headers,
    body: bytes[header_end..header_end + content_length].to_vec(),
  }
}

fn find_bytes(value: &[u8], pattern: &[u8]) -> Option<usize> {
  value
    .windows(pattern.len())
    .position(|window| window == pattern)
}

fn write_response(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) {
  try_write_response(stream, status, headers, body).expect("write response");
}

fn try_write_response(
  stream: &mut TcpStream,
  status: &str,
  headers: &[(&str, &str)],
  body: &[u8],
) -> io::Result<()> {
  write!(
    stream,
    "HTTP/1.1 {status}\r\ncontent-length: {}\r\n",
    body.len()
  )?;
  for (name, value) in headers {
    write!(stream, "{name}: {value}\r\n")?;
  }
  stream.write_all(b"\r\n")?;
  stream.write_all(body)?;
  stream.flush()
}
