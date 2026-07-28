use std::{
  collections::HashMap,
  sync::{Arc, Mutex},
  thread,
  time::Duration,
};

use researchbox_python_plugin::{
  PythonCancellationHandle, PythonExecutionResult, execute_python_with_cancellation,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::oneshot;

pub const PYTHON_PROTOCOL_VERSION: u32 = 1;
const MAX_PYTHON_CODE_BYTES: usize = 256 * 1024;
const MAX_PYTHON_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_PYTHON_TIMEOUT_MS: u64 = 60_000;
const PYTHON_THREAD_STACK_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PythonExecuteRequest {
  pub protocol_version: u32,
  pub request_id: String,
  pub operation_id: String,
  #[serde(rename = "kind")]
  pub _kind: PythonExecuteRequestKind,
  pub code: String,
  pub timeout_ms: u64,
  pub max_output_bytes: usize,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PythonExecuteRequestKind {
  PythonExecute,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PythonCancelRequest {
  pub protocol_version: u32,
  pub request_id: String,
  pub operation_id: String,
  #[serde(rename = "kind")]
  pub _kind: PythonCancelRequestKind,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PythonCancelRequestKind {
  PythonCancel,
}

#[derive(Clone, Debug, Serialize)]
pub struct PythonExecuteResponse {
  pub protocol_version: u32,
  pub request_id: String,
  pub kind: &'static str,
  pub result: PythonExecuteResult,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PythonExecuteResult {
  Complete {
    operation_id: String,
    execution: PythonExecutionResult,
  },
  Error {
    code: &'static str,
    message: String,
  },
}

#[derive(Clone, Debug, Serialize)]
pub struct PythonCancelResponse {
  pub protocol_version: u32,
  pub request_id: String,
  pub kind: &'static str,
  pub result: PythonCancelResult,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PythonCancelResult {
  Cancelled { operation_id: String },
  Error { code: &'static str, message: String },
}

#[derive(Clone, Default)]
pub struct PythonService {
  active: Arc<Mutex<HashMap<String, ActiveOperation>>>,
}

struct ActiveOperation {
  cancellation: Option<PythonCancellationHandle>,
  cancellation_requested: bool,
}

impl PythonService {
  pub fn new() -> Self {
    Self::default()
  }

  fn start(&self, operation_id: &str) -> Result<(), String> {
    let mut active = self
      .active
      .lock()
      .map_err(|_| "The native Python operation registry is unavailable.".to_owned())?;
    if active.contains_key(operation_id) {
      return Err(format!(
        "Python operation_id is already active: {operation_id}."
      ));
    }
    active.insert(
      operation_id.to_owned(),
      ActiveOperation {
        cancellation: None,
        cancellation_requested: false,
      },
    );
    Ok(())
  }

  fn register_cancellation(&self, operation_id: &str, cancellation: PythonCancellationHandle) {
    let cancellation_requested = {
      let Ok(mut active) = self.active.lock() else {
        return;
      };
      let Some(operation) = active.get_mut(operation_id) else {
        return;
      };
      operation.cancellation = Some(cancellation.clone());
      operation.cancellation_requested
    };
    if cancellation_requested {
      cancellation.cancel();
    }
  }

  fn cancel(&self, operation_id: &str) -> Result<bool, String> {
    let cancellation = {
      let mut active = self
        .active
        .lock()
        .map_err(|_| "The native Python operation registry is unavailable.".to_owned())?;
      let Some(operation) = active.get_mut(operation_id) else {
        return Ok(false);
      };
      operation.cancellation_requested = true;
      operation.cancellation.clone()
    };
    if let Some(cancellation) = cancellation {
      cancellation.cancel();
    }
    Ok(true)
  }

  fn finish(&self, operation_id: &str) -> bool {
    self
      .active
      .lock()
      .ok()
      .and_then(|mut active| active.remove(operation_id))
      .is_some_and(|operation| operation.cancellation_requested)
  }
}

#[tauri::command]
pub async fn native_python_execute(
  python: State<'_, PythonService>,
  request: PythonExecuteRequest,
) -> Result<PythonExecuteResponse, ()> {
  if let Some(response) = validate_execute_request(&request) {
    return Ok(response);
  }
  let request_id = request.request_id.clone();
  let operation_id = request.operation_id.clone();
  let service = python.inner().clone();
  if let Err(message) = service.start(&operation_id) {
    return Ok(execute_error(request_id, "busy", message));
  }

  let mut execution = match spawn_python_execution(
    service.clone(),
    operation_id.clone(),
    request.code,
    request.max_output_bytes,
  ) {
    Ok(execution) => execution,
    Err(message) => {
      service.finish(&operation_id);
      return Ok(execute_error(request_id, "internal", message));
    }
  };
  let timeout = tokio::time::sleep(Duration::from_millis(request.timeout_ms));
  tokio::pin!(timeout);

  let mut timed_out = false;
  let outcome = tokio::select! {
    outcome = &mut execution => outcome,
    () = &mut timeout => {
      timed_out = true;
      let _ = service.cancel(&operation_id);
      execution.await
    }
  };
  let cancellation_requested = service.finish(&operation_id);

  if timed_out {
    return Ok(execute_error(
      request_id,
      "timeout",
      format!("Python execution exceeded {} ms.", request.timeout_ms),
    ));
  }
  if cancellation_requested {
    return Ok(execute_error(
      request_id,
      "cancelled",
      "Python execution was cancelled.".to_owned(),
    ));
  }

  Ok(match outcome {
    Ok(Ok(execution)) => PythonExecuteResponse {
      protocol_version: PYTHON_PROTOCOL_VERSION,
      request_id,
      kind: "python_execute_result",
      result: PythonExecuteResult::Complete {
        operation_id,
        execution,
      },
    },
    Ok(Err(message)) => execute_error(request_id, "internal", message),
    Err(_) => execute_error(
      request_id,
      "internal",
      "The native Python execution thread stopped before returning a result.".to_owned(),
    ),
  })
}

fn spawn_python_execution(
  service: PythonService,
  operation_id: String,
  code: String,
  max_output_bytes: usize,
) -> Result<oneshot::Receiver<Result<PythonExecutionResult, String>>, String> {
  let (sender, receiver) = oneshot::channel();
  thread::Builder::new()
    .name("researchbox-python".to_owned())
    .stack_size(PYTHON_THREAD_STACK_BYTES)
    .spawn(move || {
      let result = execute_python_with_cancellation(&code, max_output_bytes, |cancellation| {
        service.register_cancellation(&operation_id, cancellation);
      });
      let _ = sender.send(result);
    })
    .map_err(|error| format!("Could not start the native Python execution thread: {error}"))?;
  Ok(receiver)
}

#[tauri::command]
pub async fn native_python_cancel(
  python: State<'_, PythonService>,
  request: PythonCancelRequest,
) -> Result<PythonCancelResponse, ()> {
  let request_id = request.request_id;
  if request.protocol_version != PYTHON_PROTOCOL_VERSION {
    return Ok(cancel_error(
      request_id,
      "invalid_request",
      format!(
        "Unsupported Python protocol version: {}.",
        request.protocol_version
      ),
    ));
  }
  if request_id.is_empty() || request.operation_id.is_empty() {
    return Ok(cancel_error(
      request_id,
      "invalid_request",
      "request_id and operation_id must not be empty.".to_owned(),
    ));
  }

  let operation_id = request.operation_id;
  match python.cancel(&operation_id) {
    Ok(_) => Ok(PythonCancelResponse {
      protocol_version: PYTHON_PROTOCOL_VERSION,
      request_id,
      kind: "python_cancel_result",
      result: PythonCancelResult::Cancelled { operation_id },
    }),
    Err(message) => Ok(cancel_error(request_id, "internal", message)),
  }
}

fn validate_execute_request(request: &PythonExecuteRequest) -> Option<PythonExecuteResponse> {
  if request.protocol_version != PYTHON_PROTOCOL_VERSION {
    return Some(execute_error(
      request.request_id.clone(),
      "invalid_request",
      format!(
        "Unsupported Python protocol version: {}.",
        request.protocol_version
      ),
    ));
  }
  if request.request_id.is_empty() || request.operation_id.is_empty() {
    return Some(execute_error(
      request.request_id.clone(),
      "invalid_request",
      "request_id and operation_id must not be empty.".to_owned(),
    ));
  }
  if request.code.len() > MAX_PYTHON_CODE_BYTES {
    return Some(execute_error(
      request.request_id.clone(),
      "invalid_request",
      format!("Python code exceeds {MAX_PYTHON_CODE_BYTES} UTF-8 bytes."),
    ));
  }
  if request.timeout_ms == 0 || request.timeout_ms > MAX_PYTHON_TIMEOUT_MS {
    return Some(execute_error(
      request.request_id.clone(),
      "invalid_request",
      format!("timeout_ms must be between 1 and {MAX_PYTHON_TIMEOUT_MS}."),
    ));
  }
  if request.max_output_bytes == 0 || request.max_output_bytes > MAX_PYTHON_OUTPUT_BYTES {
    return Some(execute_error(
      request.request_id.clone(),
      "invalid_request",
      format!("max_output_bytes must be between 1 and {MAX_PYTHON_OUTPUT_BYTES}."),
    ));
  }
  None
}

fn execute_error(request_id: String, code: &'static str, message: String) -> PythonExecuteResponse {
  PythonExecuteResponse {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id,
    kind: "python_execute_result",
    result: PythonExecuteResult::Error { code, message },
  }
}

fn cancel_error(request_id: String, code: &'static str, message: String) -> PythonCancelResponse {
  PythonCancelResponse {
    protocol_version: PYTHON_PROTOCOL_VERSION,
    request_id,
    kind: "python_cancel_result",
    result: PythonCancelResult::Error { code, message },
  }
}

#[cfg(test)]
mod tests {
  use super::{
    MAX_PYTHON_OUTPUT_BYTES, PYTHON_PROTOCOL_VERSION, PythonExecuteRequest,
    PythonExecuteRequestKind, PythonService, spawn_python_execution, validate_execute_request,
  };

  #[test]
  fn validates_python_execution_limits() {
    let valid = PythonExecuteRequest {
      protocol_version: PYTHON_PROTOCOL_VERSION,
      request_id: "request".to_owned(),
      operation_id: "operation".to_owned(),
      _kind: PythonExecuteRequestKind::PythonExecute,
      code: "print(42)".to_owned(),
      timeout_ms: 1_000,
      max_output_bytes: MAX_PYTHON_OUTPUT_BYTES,
    };
    assert!(validate_execute_request(&valid).is_none());

    let invalid = PythonExecuteRequest {
      max_output_bytes: MAX_PYTHON_OUTPUT_BYTES + 1,
      ..valid
    };
    assert!(validate_execute_request(&invalid).is_some());
  }

  #[tokio::test]
  async fn runs_rustpython_on_its_dedicated_native_thread() {
    let service = PythonService::new();
    let operation_id = "dedicated-thread-test".to_owned();
    service.start(&operation_id).unwrap();

    let execution = spawn_python_execution(
      service.clone(),
      operation_id.clone(),
      "print(21 * 2)".to_owned(),
      4096,
    )
    .unwrap()
    .await
    .unwrap()
    .unwrap();

    assert_eq!(execution.stdout, "42\n");
    assert_eq!(execution.error, None);
    assert!(!service.finish(&operation_id));
  }
}
