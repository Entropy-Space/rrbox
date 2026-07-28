use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const NATIVE_PROVIDER_PROTOCOL_VERSION: u32 = 1;
pub const LOCAL_OPENAI_PROVIDER_ID: &str = "local-openai";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeProviderFetchRequest {
  pub protocol_version: u32,
  pub request_id: String,
  pub operation_id: String,
  pub provider_id: String,
  pub endpoint: NativeProviderEndpoint,
  pub method: NativeProviderMethod,
  #[serde(default)]
  pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeProviderCancelRequest {
  pub protocol_version: u32,
  pub request_id: String,
  pub operation_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeProviderEndpoint {
  Models,
  ChatCompletions,
}

impl NativeProviderEndpoint {
  pub(crate) fn path(self) -> &'static str {
    match self {
      Self::Models => "/models",
      Self::ChatCompletions => "/chat/completions",
    }
  }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeProviderMethod {
  Get,
  Post,
}

#[derive(Debug, Serialize)]
pub struct NativeProviderResponse {
  pub protocol_version: u32,
  pub request_id: String,
  pub result: NativeProviderResult,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeProviderResult {
  FetchStarted {
    operation_id: String,
  },
  OperationCancelled {
    operation_id: String,
    was_active: bool,
  },
  Error {
    error: NativeProviderErrorPayload,
  },
}

#[derive(Debug, Serialize)]
pub struct NativeProviderErrorPayload {
  pub code: String,
  pub message: String,
}

impl NativeProviderResponse {
  pub fn fetch_started(request_id: String, operation_id: String) -> Self {
    Self::new(
      request_id,
      NativeProviderResult::FetchStarted { operation_id },
    )
  }

  pub fn operation_cancelled(request_id: String, operation_id: String, was_active: bool) -> Self {
    Self::new(
      request_id,
      NativeProviderResult::OperationCancelled {
        operation_id,
        was_active,
      },
    )
  }

  pub fn error(request_id: String, code: impl Into<String>, message: impl Into<String>) -> Self {
    Self::new(
      request_id,
      NativeProviderResult::Error {
        error: NativeProviderErrorPayload {
          code: code.into(),
          message: message.into(),
        },
      },
    )
  }

  fn new(request_id: String, result: NativeProviderResult) -> Self {
    Self {
      protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
      request_id,
      result,
    }
  }
}

#[derive(Debug, Serialize)]
pub struct NativeProviderBodyEvent {
  pub protocol_version: u32,
  pub operation_id: String,
  pub event_index: u64,
  #[serde(flatten)]
  pub payload: NativeProviderBodyEventPayload,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeProviderBodyEventPayload {
  ResponseStarted {
    status: u16,
    status_text: String,
    headers: BTreeMap<String, String>,
  },
  BodyChunk {
    chunk_base64: String,
  },
  BodyFinished {
    status: NativeProviderBodyStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
  },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeProviderBodyStatus {
  Complete,
  Aborted,
  Error,
}

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::{
    NATIVE_PROVIDER_PROTOCOL_VERSION, NativeProviderBodyEvent, NativeProviderBodyEventPayload,
    NativeProviderBodyStatus, NativeProviderFetchRequest,
  };

  #[test]
  fn body_events_use_the_flat_snake_case_wire_shape() {
    let event = NativeProviderBodyEvent {
      protocol_version: NATIVE_PROVIDER_PROTOCOL_VERSION,
      operation_id: "operation-1".into(),
      event_index: 3,
      payload: NativeProviderBodyEventPayload::BodyFinished {
        status: NativeProviderBodyStatus::Error,
        error_message: Some("failed".into()),
      },
    };

    assert_eq!(
      serde_json::to_value(event).expect("serialize body event"),
      json!({
        "protocol_version": 1,
        "operation_id": "operation-1",
        "event_index": 3,
        "kind": "body_finished",
        "status": "error",
        "error_message": "failed",
      })
    );
  }

  #[test]
  fn fetch_requests_reject_unknown_fields() {
    let error = serde_json::from_value::<NativeProviderFetchRequest>(json!({
      "protocol_version": 1,
      "request_id": "request-1",
      "operation_id": "operation-1",
      "provider_id": "local-openai",
      "endpoint": "models",
      "method": "get",
      "url": "http://attacker.invalid/",
    }))
    .expect_err("unknown URL field must not cross the constrained wire");

    assert!(error.to_string().contains("unknown field"));
  }
}
