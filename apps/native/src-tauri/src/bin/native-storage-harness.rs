use std::{
  env,
  io::{self, BufRead, Write},
  path::PathBuf,
  process::ExitCode,
  thread,
};

use researchbox_native::{
  protocol::{NATIVE_STORAGE_PROTOCOL_VERSION, NativeStorageRequest, NativeStorageResponse},
  storage::StorageService,
};
use serde_json::Value;

fn main() -> ExitCode {
  match run() {
    Ok(()) => ExitCode::SUCCESS,
    Err(message) => {
      eprintln!("{message}");
      ExitCode::FAILURE
    }
  }
}

fn run() -> Result<(), String> {
  let root = parse_root_argument()?;
  let storage = StorageService::new(root)
    .map_err(|error| format!("Could not construct native storage: {error}"))?;
  storage
    .initialize()
    .map_err(|error| format!("Could not initialize native storage: {error}"))?;

  let stdin = io::stdin();
  let mut workers = Vec::new();
  for line in stdin.lock().lines() {
    let line = line.map_err(|error| format!("Could not read harness request: {error}"))?;
    if line.trim().is_empty() {
      continue;
    }
    let storage = storage.clone();
    workers.push(thread::spawn(move || {
      write_response(&handle_request(&storage, &line))
    }));
  }
  for worker in workers {
    worker
      .join()
      .map_err(|_| "A native storage harness worker panicked.".to_owned())??;
  }
  Ok(())
}

fn write_response(response: &NativeStorageResponse) -> Result<(), String> {
  let encoded = serde_json::to_string(response)
    .map_err(|error| format!("Could not encode harness response: {error}"))?;
  let stdout = io::stdout();
  let mut output = stdout.lock();
  output
    .write_all(encoded.as_bytes())
    .and_then(|()| output.write_all(b"\n"))
    .and_then(|()| output.flush())
    .map_err(|error| format!("Could not write harness response: {error}"))
}

fn parse_root_argument() -> Result<PathBuf, String> {
  let mut arguments = env::args_os().skip(1);
  let flag = arguments
    .next()
    .ok_or_else(|| "Usage: native-storage-harness --root <directory>".to_owned())?;
  if flag != "--root" {
    return Err("Usage: native-storage-harness --root <directory>".to_owned());
  }
  let root = arguments
    .next()
    .map(PathBuf::from)
    .ok_or_else(|| "The --root argument requires a directory.".to_owned())?;
  if arguments.next().is_some() {
    return Err("Usage: native-storage-harness --root <directory>".to_owned());
  }
  Ok(root)
}

fn handle_request(storage: &StorageService, line: &str) -> NativeStorageResponse {
  let value = match serde_json::from_str::<Value>(line) {
    Ok(value) => value,
    Err(error) => {
      return NativeStorageResponse::error(
        String::new(),
        "invalid_request",
        format!("Request is not valid JSON: {error}"),
      );
    }
  };
  let request_id = value
    .get("request_id")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_owned();
  let request = match serde_json::from_value::<NativeStorageRequest>(value) {
    Ok(request) => request,
    Err(error) => {
      return NativeStorageResponse::error(
        request_id,
        "invalid_request",
        format!("Request does not match the native storage protocol: {error}"),
      );
    }
  };
  if request.protocol_version != NATIVE_STORAGE_PROTOCOL_VERSION {
    return NativeStorageResponse::error(
      request.request_id,
      "invalid_request",
      format!(
        "Unsupported native storage protocol version: {}.",
        request.protocol_version
      ),
    );
  }
  if request.request_id.is_empty() {
    return NativeStorageResponse::error(
      request.request_id,
      "invalid_request",
      "request_id must be a non-empty string.",
    );
  }

  let request_id = request.request_id;
  match storage.execute(request.operation) {
    Ok(result) => NativeStorageResponse::new(request_id, result),
    Err(error) => NativeStorageResponse::error(request_id, error.code(), error.to_string()),
  }
}
