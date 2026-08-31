use serde::{Deserialize, Serialize, de::Deserializer};
use serde_json::Value;

pub const NATIVE_STORAGE_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeStorageRequest {
  pub protocol_version: u32,
  pub request_id: String,
  pub operation: NativeStorageOperation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeStorageOperation {
  Health,
  Initialize,
  ProjectStoreLoad,
  ProjectStoreSave {
    state: Value,
    expected_revision: Option<u64>,
  },
  DshSessionLoad {
    project_id: String,
    session_id: String,
  },
  DshSessionLoadFrom {
    project_id: String,
    session_id: String,
    from_seq: u64,
  },
  DshSessionReadRevision {
    project_id: String,
    session_id: String,
  },
  DshSessionAppend {
    project_id: String,
    header: Value,
    events: Vec<Value>,
    is_materialized: bool,
  },
  DshSessionList {
    project_id: String,
  },
  DshSessionDelete {
    project_id: String,
    session_id: String,
  },
  WorkspaceCreate {
    project_id: String,
    #[serde(default)]
    initial_files: Option<Vec<Value>>,
  },
  WorkspaceOpen {
    project_id: String,
  },
  WorkspaceDelete {
    project_id: String,
  },
  WorkspaceReconcileOrphans {
    retained_project_ids: Vec<String>,
  },
  WorkspaceList {
    workspace: WorkspaceHandle,
    path: String,
  },
  WorkspaceRead {
    workspace: WorkspaceHandle,
    path: String,
  },
  WorkspaceGetPathState {
    workspace: WorkspaceHandle,
    path: String,
  },
  WorkspaceReadFilesSnapshot {
    workspace: WorkspaceHandle,
  },
  WorkspaceWrite {
    workspace: WorkspaceHandle,
    path: String,
    content: String,
    #[serde(default)]
    options: Option<WorkspaceWriteOptions>,
  },
  WorkspaceRemove {
    workspace: WorkspaceHandle,
    path: String,
    #[serde(default)]
    options: Option<WorkspaceRemoveOptions>,
  },
  WorkspaceListChanges {
    workspace: WorkspaceHandle,
  },
  WorkspaceGetChange {
    workspace: WorkspaceHandle,
    change_id: String,
  },
  WorkspaceRevertChange {
    workspace: WorkspaceHandle,
    change_id: String,
  },
  ProjectUsage {
    project_id: String,
  },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceHandle {
  pub project_id: String,
  pub incarnation_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DshSessionRevision {
  pub storage_id: String,
  pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DshStoredSession {
  pub header: Value,
  pub events: Vec<Value>,
  pub storage_id: String,
  pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DshStoredSessionSuffix {
  pub header: Value,
  pub events: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VfsSeedFile {
  pub path: String,
  pub content: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ExpectedContent {
  #[default]
  Unspecified,
  Exact(Option<String>),
}

impl<'de> Deserialize<'de> for ExpectedContent {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: Deserializer<'de>,
  {
    Option::<String>::deserialize(deserializer).map(Self::Exact)
  }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceWriteOptions {
  #[serde(default)]
  pub expected_content: ExpectedContent,
  #[serde(default)]
  pub change: Option<WorkspaceChangeMetadata>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceRemoveOptions {
  #[serde(default)]
  pub expected_content: Option<String>,
  #[serde(default)]
  pub change: Option<WorkspaceChangeMetadata>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceChangeMetadata {
  pub change_id: String,
  pub session_id: String,
  pub tool_call_block_id: String,
  pub assistant_message_index: u64,
  pub tool_call_id: String,
  pub tool_name: WorkspaceToolName,
  pub created_at: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceToolName {
  WriteFile,
  ReplaceText,
  RemoveFile,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkspaceChangeRecord {
  pub change_id: String,
  pub session_id: String,
  pub tool_call_block_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub legacy_message_id: Option<String>,
  pub assistant_message_index: Option<u64>,
  pub tool_call_id: String,
  pub tool_name: WorkspaceToolName,
  pub created_at: String,
  pub applied_workspace_revision: Option<u64>,
  pub reverted_at_workspace_revision: Option<u64>,
  pub path: String,
  pub change_kind: WorkspaceChangeKind,
  pub before_content: Option<String>,
  pub after_content: Option<String>,
  pub additions: u64,
  pub deletions: u64,
  pub byte_size: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceChangeKind {
  Created,
  Updated,
  Deleted,
}

#[derive(Debug, Serialize)]
pub struct NativeStorageResponse {
  pub protocol_version: u32,
  pub request_id: String,
  pub result: NativeStorageResult,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeStorageResult {
  Health {
    initialized: bool,
  },
  Initialized,
  ProjectStoreLoaded {
    state: Option<Value>,
  },
  ProjectStoreSaved,
  DshSessionLoaded {
    value: Option<DshStoredSession>,
  },
  DshSessionSuffixLoaded {
    value: Option<DshStoredSessionSuffix>,
  },
  DshSessionRevision {
    value: Option<DshSessionRevision>,
  },
  DshSessionAppended,
  DshSessionsListed {
    headers: Vec<Value>,
  },
  DshSessionDeleted,
  WorkspaceOpened {
    workspace: WorkspaceHandle,
  },
  WorkspaceDeleted,
  WorkspaceOrphansReconciled,
  WorkspaceListed {
    value: Value,
  },
  WorkspaceRead {
    value: Value,
  },
  WorkspacePathState {
    value: Value,
  },
  WorkspaceFilesSnapshot {
    value: Value,
  },
  WorkspaceWritten {
    value: Value,
  },
  WorkspaceRemoved {
    value: Value,
  },
  WorkspaceChangesListed {
    value: Value,
  },
  WorkspaceChange {
    value: Value,
  },
  WorkspaceChangeReverted {
    value: Value,
  },
  ProjectUsage {
    value: ProjectUsage,
  },
  Error {
    error: NativeStorageErrorPayload,
  },
}

#[derive(Debug, Serialize)]
pub struct ProjectUsage {
  pub logical_bytes: u64,
  pub database_bytes: u64,
  pub disk_bytes: u64,
  pub breakdown: ProjectUsageBreakdown,
}

#[derive(Debug, Serialize)]
pub struct ProjectUsageBreakdown {
  pub workspace_bytes: u64,
  pub conversation_bytes: u64,
  pub history_bytes: u64,
  pub database_overhead_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct NativeStorageErrorPayload {
  pub code: String,
  pub message: String,
}

impl NativeStorageResponse {
  pub fn new(request_id: String, result: NativeStorageResult) -> Self {
    Self {
      protocol_version: NATIVE_STORAGE_PROTOCOL_VERSION,
      request_id,
      result,
    }
  }

  pub fn error(request_id: String, code: impl Into<String>, message: impl Into<String>) -> Self {
    Self::new(
      request_id,
      NativeStorageResult::Error {
        error: NativeStorageErrorPayload {
          code: code.into(),
          message: message.into(),
        },
      },
    )
  }
}

pub fn deserialize_u64_from_json(value: &Value, field: &str) -> Result<u64, String> {
  value
    .get(field)
    .and_then(Value::as_u64)
    .ok_or_else(|| format!("{field} must be a non-negative integer."))
}

pub fn require_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
  value
    .get(field)
    .and_then(Value::as_str)
    .filter(|candidate| !candidate.is_empty())
    .ok_or_else(|| format!("{field} must be a non-empty string."))
}

pub fn require_array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
  value
    .get(field)
    .and_then(Value::as_array)
    .ok_or_else(|| format!("{field} must be an array."))
}

#[cfg(test)]
mod tests {
  use serde_json::{Value, json};

  use super::{
    ExpectedContent, NativeStorageOperation, NativeStorageRequest, WorkspaceWriteOptions,
  };

  fn assert_rejects_unknown_field(label: &str, value: Value) {
    assert!(
      serde_json::from_value::<NativeStorageRequest>(value).is_err(),
      "{label} accepted an unknown field"
    );
  }

  fn write_options(expected_content: Option<&str>) -> WorkspaceWriteOptions {
    let expected_field = expected_content
      .map(|value| format!(r#","expected_content":{value}"#))
      .unwrap_or_default();
    let request: NativeStorageRequest = serde_json::from_str(&format!(
      r#"{{
        "protocol_version":1,
        "request_id":"request-1",
        "operation":{{
          "kind":"workspace_write",
          "workspace":{{
            "project_id":"project-1",
            "incarnation_id":"incarnation-1"
          }},
          "path":"/file.txt",
          "content":"content",
          "options":{{"change":null{expected_field}}}
        }}
      }}"#
    ))
    .expect("wire request");
    let NativeStorageOperation::WorkspaceWrite { options, .. } = request.operation else {
      panic!("expected workspace_write");
    };
    options.expect("write options")
  }

  #[test]
  fn expected_content_preserves_omitted_null_and_string() {
    assert_eq!(
      write_options(None).expected_content,
      ExpectedContent::Unspecified
    );
    assert_eq!(
      write_options(Some("null")).expected_content,
      ExpectedContent::Exact(None)
    );
    assert_eq!(
      write_options(Some(r#""before""#)).expected_content,
      ExpectedContent::Exact(Some("before".into()))
    );
  }

  #[test]
  fn inbound_request_containers_reject_unknown_fields() {
    assert_rejects_unknown_field(
      "request",
      json!({
        "protocol_version": 1,
        "request_id": "request-1",
        "operation": { "kind": "health" },
        "unexpected": true,
      }),
    );
    assert_rejects_unknown_field(
      "operation",
      json!({
        "protocol_version": 1,
        "request_id": "request-1",
        "operation": {
          "kind": "workspace_open",
          "project_id": "project-1",
          "unexpected": true,
        },
      }),
    );
    assert_rejects_unknown_field(
      "workspace handle",
      json!({
        "protocol_version": 1,
        "request_id": "request-1",
        "operation": {
          "kind": "workspace_read",
          "workspace": {
            "project_id": "project-1",
            "incarnation_id": "incarnation-1",
            "unexpected": true,
          },
          "path": "/file.txt",
        },
      }),
    );
    assert_rejects_unknown_field(
      "workspace options",
      json!({
        "protocol_version": 1,
        "request_id": "request-1",
        "operation": {
          "kind": "workspace_write",
          "workspace": {
            "project_id": "project-1",
            "incarnation_id": "incarnation-1",
          },
          "path": "/file.txt",
          "content": "content",
          "options": {
            "unexpected": true,
          },
        },
      }),
    );
    assert_rejects_unknown_field(
      "workspace change metadata",
      json!({
        "protocol_version": 1,
        "request_id": "request-1",
        "operation": {
          "kind": "workspace_write",
          "workspace": {
            "project_id": "project-1",
            "incarnation_id": "incarnation-1",
          },
          "path": "/file.txt",
          "content": "content",
          "options": {
            "change": {
              "change_id": "change-1",
              "session_id": "session-1",
              "tool_call_block_id": "block-1",
              "assistant_message_index": 0,
              "tool_call_id": "call-1",
              "tool_name": "write_file",
              "created_at": "2026-07-28T00:00:00.000Z",
              "unexpected": true,
            },
          },
        },
      }),
    );
  }
}
