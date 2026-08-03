use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::protocol::{deserialize_u64_from_json, require_array, require_string};

use super::super::StorageError;

pub(super) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PROJECT_STORE_SCHEMA_VERSION: u64 = 4;
const LINEAR_SESSION_DOCUMENT_FORMAT_VERSION: u64 = 4;
const SESSION_DOCUMENT_FORMAT_VERSION: u64 = 5;
const SESSION_HISTORY_FORMAT_VERSION: u64 = 1;

#[derive(Debug)]
pub(super) struct ValidatedProjectState<'a> {
  pub(super) schema_version: u64,
  pub(super) state_revision: u64,
  pub(super) active_project_id: &'a str,
  pub(super) active_session_id: Option<&'a str>,
  pub(super) projects: &'a Vec<Value>,
  pub(super) sessions: &'a Vec<Value>,
  pub(super) documents: &'a Vec<Value>,
}

pub(super) fn validate_project_state(
  value: &Value,
) -> Result<ValidatedProjectState<'_>, StorageError> {
  let object = value
    .as_object()
    .ok_or_else(|| StorageError::InvalidRequest("Project store state must be an object.".into()))?;
  let schema_version =
    deserialize_u64_from_json(value, "schema_version").map_err(StorageError::InvalidRequest)?;
  if schema_version != PROJECT_STORE_SCHEMA_VERSION {
    return Err(StorageError::InvalidRequest(format!(
      "Unsupported project store schema version: {schema_version}."
    )));
  }
  let state_revision =
    deserialize_u64_from_json(value, "state_revision").map_err(StorageError::InvalidRequest)?;
  if state_revision > MAX_SAFE_INTEGER {
    return Err(StorageError::InvalidRequest(
      "state_revision exceeds the safe integer range.".into(),
    ));
  }
  let active_project_id =
    require_string(value, "active_project_id").map_err(StorageError::InvalidRequest)?;
  let active_session_id = match object.get("active_session_id") {
    Some(Value::Null) => None,
    Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
    _ => {
      return Err(StorageError::InvalidRequest(
        "active_session_id must be a non-empty string or null.".into(),
      ));
    }
  };
  let projects = require_array(value, "projects").map_err(StorageError::InvalidRequest)?;
  let sessions = require_array(value, "sessions").map_err(StorageError::InvalidRequest)?;
  let documents = require_array(value, "documents").map_err(StorageError::InvalidRequest)?;
  if projects.is_empty() {
    return Err(StorageError::InvalidRequest(
      "Project store must contain at least one project.".into(),
    ));
  }

  let mut project_ids = HashSet::new();
  for project in projects {
    let project_id = require_string(project, "project_id").map_err(StorageError::InvalidRequest)?;
    validate_project_record(project)?;
    if !project_ids.insert(project_id) {
      return Err(StorageError::InvalidRequest(format!(
        "Duplicate project: {project_id}."
      )));
    }
  }
  if !project_ids.contains(active_project_id) {
    return Err(StorageError::InvalidRequest(
      "Active project does not exist.".into(),
    ));
  }

  let mut session_ids = HashSet::new();
  let mut session_projects = HashMap::new();
  let mut unsubmitted_session_candidates = HashSet::new();
  for session in sessions {
    let session_id = require_string(session, "session_id").map_err(StorageError::InvalidRequest)?;
    let project_id = require_string(session, "project_id").map_err(StorageError::InvalidRequest)?;
    validate_session_record(session)?;
    if !project_ids.contains(project_id) {
      return Err(StorageError::InvalidRequest(format!(
        "Session {session_id} references an unknown project."
      )));
    }
    if !session_ids.insert(session_id) {
      return Err(StorageError::InvalidRequest(format!(
        "Duplicate session: {session_id}."
      )));
    }
    session_projects.insert(session_id, project_id);
    if session.get("title").and_then(Value::as_str) == Some("New chat")
      && session.get("title_is_custom").and_then(Value::as_bool) == Some(false)
    {
      unsubmitted_session_candidates.insert(session_id);
    }
  }
  for project in projects {
    let project_id = require_string(project, "project_id").map_err(StorageError::InvalidRequest)?;
    let last_session_id = match project.get("last_session_id") {
      Some(Value::Null) => None,
      Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
      _ => {
        return Err(StorageError::InvalidRequest(format!(
          "Project {project_id} has an invalid last_session_id."
        )));
      }
    };
    if let Some(session_id) = last_session_id
      && session_projects.get(session_id).copied() != Some(project_id)
    {
      return Err(StorageError::InvalidRequest(format!(
        "Project {project_id} has an invalid last_session_id."
      )));
    }
  }

  let mut document_ids = HashSet::new();
  for document in documents {
    let session_id =
      require_string(document, "session_id").map_err(StorageError::InvalidRequest)?;
    let project_id =
      require_string(document, "project_id").map_err(StorageError::InvalidRequest)?;
    let timeline = validate_session_document(document)?;
    if !document_ids.insert(session_id) {
      return Err(StorageError::InvalidRequest(format!(
        "Duplicate session document: {session_id}."
      )));
    }
    if session_projects.get(session_id).copied() != Some(project_id) {
      return Err(StorageError::InvalidRequest(format!(
        "Session document {session_id} does not match its session."
      )));
    }
    if timeline.is_empty() && unsubmitted_session_candidates.contains(session_id) {
      return Err(StorageError::InvalidRequest(
        "Unsubmitted new chats must not be persisted as sessions.".into(),
      ));
    }
  }
  if session_ids != document_ids {
    return Err(StorageError::InvalidRequest(
      "Every session must have exactly one session document.".into(),
    ));
  }
  if let Some(active_session_id) = active_session_id
    && session_projects.get(active_session_id).copied() != Some(active_project_id)
  {
    return Err(StorageError::InvalidRequest(
      "Active session does not belong to the active project.".into(),
    ));
  }

  Ok(ValidatedProjectState {
    schema_version,
    state_revision,
    active_project_id,
    active_session_id,
    projects,
    sessions,
    documents,
  })
}

fn validate_project_record(project: &Value) -> Result<(), StorageError> {
  for field in ["name", "created_at", "updated_at"] {
    require_string(project, field).map_err(StorageError::InvalidRequest)?;
  }
  require_any_string(project, "new_chat_draft")?;
  validate_model_selection(project.get("new_chat_model"), "new_chat_model")?;
  validate_reasoning_effort(
    project.get("new_chat_reasoning_effort"),
    "new_chat_reasoning_effort",
  )
}

fn validate_session_record(session: &Value) -> Result<(), StorageError> {
  for field in ["title", "created_at", "updated_at"] {
    require_string(session, field).map_err(StorageError::InvalidRequest)?;
  }
  require_boolean(session, "title_is_custom")?;
  validate_model_selection(session.get("selected_model"), "selected_model")?;
  validate_reasoning_effort(session.get("reasoning_effort"), "reasoning_effort")
}

fn validate_model_selection(value: Option<&Value>, field: &str) -> Result<(), StorageError> {
  let value = value
    .and_then(Value::as_object)
    .ok_or_else(|| StorageError::InvalidRequest(format!("{field} must be an object.")))?;
  for key in ["provider_id", "model_id"] {
    value
      .get(key)
      .and_then(Value::as_str)
      .filter(|candidate| !candidate.is_empty())
      .ok_or_else(|| {
        StorageError::InvalidRequest(format!("{field}.{key} must be a non-empty string."))
      })?;
  }
  Ok(())
}

fn validate_reasoning_effort(value: Option<&Value>, field: &str) -> Result<(), StorageError> {
  match value.and_then(Value::as_str) {
    Some("default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh") => Ok(()),
    _ => Err(StorageError::InvalidRequest(format!(
      "{field} must be a supported reasoning effort."
    ))),
  }
}

fn validate_session_document(document: &Value) -> Result<&Vec<Value>, StorageError> {
  let format_version =
    deserialize_u64_from_json(document, "format_version").map_err(StorageError::InvalidRequest)?;
  if format_version != SESSION_DOCUMENT_FORMAT_VERSION
    && format_version != LINEAR_SESSION_DOCUMENT_FORMAT_VERSION
  {
    return Err(StorageError::InvalidRequest(format!(
      "Unsupported session document format version: {format_version}."
    )));
  }
  require_any_string(document, "input_draft")?;
  let timeline = require_array(document, "timeline").map_err(StorageError::InvalidRequest)?;
  validate_timeline(timeline)?;
  if format_version == SESSION_DOCUMENT_FORMAT_VERSION {
    validate_session_history(document)?;
  }
  Ok(timeline)
}

fn validate_session_history(document: &Value) -> Result<(), StorageError> {
  let history = document
    .get("history")
    .and_then(Value::as_object)
    .ok_or_else(|| StorageError::InvalidRequest("Session history must be an object.".into()))?;
  let format_version = history
    .get("format_version")
    .and_then(Value::as_u64)
    .ok_or_else(|| {
      StorageError::InvalidRequest("format_version must be a non-negative integer.".into())
    })?;
  if format_version != SESSION_HISTORY_FORMAT_VERSION {
    return Err(StorageError::InvalidRequest(
      "Unsupported session history format version.".into(),
    ));
  }
  let active_leaf_id = match history.get("active_leaf_id") {
    Some(Value::Null) => None,
    Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
    _ => {
      return Err(StorageError::InvalidRequest(
        "Session history active_leaf_id must be a non-empty string or null.".into(),
      ));
    }
  };
  let nodes = history
    .get("nodes")
    .and_then(Value::as_array)
    .ok_or_else(|| {
      StorageError::InvalidRequest("Session history nodes must be an array.".into())
    })?;
  let mut parents: HashMap<String, Option<String>> = HashMap::new();
  for node in nodes {
    let node_id = require_string(node, "node_id")
      .map_err(StorageError::InvalidRequest)?
      .to_string();
    let entry_id = require_string(node, "entry_id").map_err(StorageError::InvalidRequest)?;
    if node_id != entry_id {
      return Err(StorageError::InvalidRequest(
        "Session history node_id must match entry_id.".into(),
      ));
    }
    if node.get("entry").and_then(Value::as_object).is_none() {
      return Err(StorageError::InvalidRequest(
        "Session history entry must be an object.".into(),
      ));
    }
    let parent = match node.get("parent_node_id") {
      Some(Value::Null) => None,
      Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
      _ => {
        return Err(StorageError::InvalidRequest(
          "Session history parent_node_id must be a non-empty string or null.".into(),
        ));
      }
    };
    if parents.insert(node_id, parent).is_some() {
      return Err(StorageError::InvalidRequest(
        "Duplicate session history node_id.".into(),
      ));
    }
  }
  if let Some(active_leaf_id) = &active_leaf_id
    && !parents.contains_key(active_leaf_id)
  {
    return Err(StorageError::InvalidRequest(
      "Session history active leaf does not exist.".into(),
    ));
  }
  for node_id in parents.keys() {
    let mut visited = HashSet::new();
    let mut current = Some(node_id.clone());
    while let Some(current_id) = current {
      if !visited.insert(current_id.clone()) {
        return Err(StorageError::InvalidRequest(
          "Session history contains a cycle.".into(),
        ));
      }
      current = parents.get(&current_id).cloned().flatten();
    }
  }
  Ok(())
}

fn validate_timeline(timeline: &[Value]) -> Result<(), StorageError> {
  let mut entry_ids = HashSet::new();
  let mut block_ids = HashSet::new();
  let mut seen_runs = HashSet::new();
  let mut resolved_tool_calls = HashSet::new();
  let mut pending_tool_calls: HashMap<&str, (&str, &str, &str)> = HashMap::new();
  let mut current_run_id: Option<&str> = None;

  for entry in timeline {
    let entry_type = require_string(entry, "type").map_err(StorageError::InvalidRequest)?;
    let entry_id = require_string(entry, "entry_id").map_err(StorageError::InvalidRequest)?;
    let run_id = require_string(entry, "run_id").map_err(StorageError::InvalidRequest)?;
    let created_at = require_string(entry, "created_at").map_err(StorageError::InvalidRequest)?;
    validate_canonical_timestamp(created_at, "timeline entry created_at")?;
    if !entry_ids.insert(entry_id) {
      return Err(StorageError::InvalidRequest(format!(
        "Duplicate timeline entry_id: {entry_id}."
      )));
    }
    if !pending_tool_calls.is_empty() && entry_type != "tool_result" {
      return Err(StorageError::InvalidRequest(
        "Assistant tool calls must be followed immediately by their tool results.".into(),
      ));
    }
    if current_run_id != Some(run_id) {
      if !seen_runs.insert(run_id) {
        return Err(StorageError::InvalidRequest(format!(
          "Timeline run is not contiguous: {run_id}."
        )));
      }
      if entry_type != "user_message" {
        return Err(StorageError::InvalidRequest(
          "Every timeline run must start with a user_message.".into(),
        ));
      }
      current_run_id = Some(run_id);
    } else if entry_type == "user_message" {
      return Err(StorageError::InvalidRequest(
        "A timeline run must contain exactly one user_message.".into(),
      ));
    }

    match entry_type {
      "user_message" => {
        require_any_string(entry, "content")?;
      }
      "assistant_message" => {
        validate_assistant_message(entry)?;
        let blocks = require_array(entry, "blocks").map_err(StorageError::InvalidRequest)?;
        let mut raw_tool_call_ids = HashSet::new();
        for block in blocks {
          let block_type = require_string(block, "type").map_err(StorageError::InvalidRequest)?;
          let block_id = require_string(block, "block_id").map_err(StorageError::InvalidRequest)?;
          if !block_ids.insert(block_id) {
            return Err(StorageError::InvalidRequest(format!(
              "Duplicate assistant block_id: {block_id}."
            )));
          }
          match block_type {
            "assistant_text" => {
              require_any_string(block, "text")?;
              validate_optional_string(block, "text_signature", true)?;
            }
            "reasoning" => {
              require_any_string(block, "text")?;
              validate_optional_string(block, "thinking_signature", true)?;
              validate_optional_boolean(block, "redacted")?;
            }
            "tool_call" => {
              let tool_call_id =
                require_string(block, "tool_call_id").map_err(StorageError::InvalidRequest)?;
              let tool_name =
                require_string(block, "tool_name").map_err(StorageError::InvalidRequest)?;
              if !raw_tool_call_ids.insert(tool_call_id) {
                return Err(StorageError::InvalidRequest(format!(
                  "Duplicate tool_call_id in assistant message: {tool_call_id}."
                )));
              }
              block
                .get("arguments")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                  StorageError::InvalidRequest("Tool arguments must be an object.".into())
                })?;
              validate_optional_string(block, "thought_signature", true)?;
              validate_optional_string(block, "label", true)?;
              pending_tool_calls.insert(block_id, (run_id, tool_call_id, tool_name));
            }
            _ => {
              return Err(StorageError::InvalidRequest(
                "Invalid assistant block type.".into(),
              ));
            }
          }
        }
      }
      "tool_result" => {
        let block_id =
          require_string(entry, "tool_call_block_id").map_err(StorageError::InvalidRequest)?;
        let tool_call_id =
          require_string(entry, "tool_call_id").map_err(StorageError::InvalidRequest)?;
        let tool_name = require_string(entry, "tool_name").map_err(StorageError::InvalidRequest)?;
        require_any_string(entry, "content")?;
        require_boolean(entry, "is_error")?;
        validate_optional_string(entry, "summary", true)?;
        if !resolved_tool_calls.insert(block_id) {
          return Err(StorageError::InvalidRequest(
            "A tool_call block can have at most one tool result.".into(),
          ));
        }
        let Some((expected_run_id, expected_tool_call_id, expected_tool_name)) =
          pending_tool_calls.remove(block_id)
        else {
          return Err(StorageError::InvalidRequest(
            "Tool result must reference the active assistant tool-call group.".into(),
          ));
        };
        if expected_run_id != run_id
          || expected_tool_call_id != tool_call_id
          || expected_tool_name != tool_name
        {
          return Err(StorageError::InvalidRequest(
            "Tool result identity must match its tool_call block.".into(),
          ));
        }
        if let Some(file_change) = entry.get("file_change") {
          validate_workspace_change_summary(file_change, tool_call_id, tool_name)?;
        }
      }
      _ => {
        return Err(StorageError::InvalidRequest(
          "Invalid timeline entry type.".into(),
        ));
      }
    }
  }
  Ok(())
}

fn validate_assistant_message(entry: &Value) -> Result<(), StorageError> {
  let status = require_string(entry, "status").map_err(StorageError::InvalidRequest)?;
  if !matches!(status, "streaming" | "complete" | "aborted" | "error") {
    return Err(StorageError::InvalidRequest(
      "Invalid assistant message status.".into(),
    ));
  }
  for field in ["api", "provider", "model"] {
    require_string(entry, field).map_err(StorageError::InvalidRequest)?;
  }
  validate_optional_string(entry, "response_model", false)?;
  validate_optional_string(entry, "response_id", false)?;
  validate_optional_string(entry, "error_message", true)?;
  let stop_reason = entry.get("stop_reason").map(|value| {
    value
      .as_str()
      .filter(|candidate| {
        matches!(
          *candidate,
          "stop" | "length" | "tool_use" | "error" | "aborted"
        )
      })
      .ok_or_else(|| StorageError::InvalidRequest("Invalid assistant stop_reason.".into()))
  });
  let stop_reason = stop_reason.transpose()?;
  let completion_is_valid = match status {
    "streaming" => stop_reason.is_none(),
    "complete" => matches!(stop_reason, Some("stop" | "length" | "tool_use")),
    "aborted" => stop_reason == Some("aborted"),
    "error" => stop_reason == Some("error"),
    _ => false,
  };
  if !completion_is_valid {
    return Err(StorageError::InvalidRequest(
      "Assistant message status and stop_reason are inconsistent.".into(),
    ));
  }
  let usage = entry
    .get("usage")
    .and_then(Value::as_object)
    .ok_or_else(|| StorageError::InvalidRequest("Assistant usage must be an object.".into()))?;
  for field in [
    "input",
    "output",
    "cache_read",
    "cache_write",
    "total_tokens",
  ] {
    require_non_negative_number(usage, field, "Assistant usage")?;
  }
  let cost = usage
    .get("cost")
    .and_then(Value::as_object)
    .ok_or_else(|| {
      StorageError::InvalidRequest("Assistant usage cost must be an object.".into())
    })?;
  for field in ["input", "output", "cache_read", "cache_write", "total"] {
    require_non_negative_number(cost, field, "Assistant usage cost")?;
  }
  require_array(entry, "blocks").map_err(StorageError::InvalidRequest)?;
  Ok(())
}

fn validate_workspace_change_summary(
  value: &Value,
  tool_call_id: &str,
  tool_name: &str,
) -> Result<(), StorageError> {
  let summary = value.as_object().ok_or_else(|| {
    StorageError::InvalidRequest("Workspace change summary must be an object.".into())
  })?;
  for field in [
    "change_id",
    "tool_call_id",
    "tool_name",
    "path",
    "change_kind",
  ] {
    summary
      .get(field)
      .and_then(Value::as_str)
      .filter(|candidate| !candidate.is_empty())
      .ok_or_else(|| {
        StorageError::InvalidRequest(format!(
          "Workspace change summary {field} must be a non-empty string."
        ))
      })?;
  }
  let summary_tool_call_id = summary["tool_call_id"].as_str().unwrap_or_default();
  let summary_tool_name = summary["tool_name"].as_str().unwrap_or_default();
  let change_kind = summary["change_kind"].as_str().unwrap_or_default();
  if summary_tool_call_id != tool_call_id || summary_tool_name != tool_name {
    return Err(StorageError::InvalidRequest(
      "Tool result file_change must match its tool identity.".into(),
    ));
  }
  let tool_matches_kind = matches!(
    (summary_tool_name, change_kind),
    ("write_file", "created" | "updated")
      | ("replace_text", "updated")
      | ("remove_file", "deleted")
  );
  if !tool_matches_kind {
    return Err(StorageError::InvalidRequest(
      "Workspace change summary tool and change kind are inconsistent.".into(),
    ));
  }
  for field in ["additions", "deletions", "byte_size"] {
    let value = summary.get(field).and_then(Value::as_u64).ok_or_else(|| {
      StorageError::InvalidRequest(format!(
        "Workspace change summary {field} must be a non-negative integer."
      ))
    })?;
    if value > MAX_SAFE_INTEGER {
      return Err(StorageError::InvalidRequest(format!(
        "Workspace change summary {field} exceeds the safe integer range."
      )));
    }
  }
  Ok(())
}

fn validate_canonical_timestamp(value: &str, field: &str) -> Result<(), StorageError> {
  let canonical = chrono::DateTime::parse_from_rfc3339(value)
    .map(|timestamp| {
      timestamp
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    })
    .map_err(|_| {
      StorageError::InvalidRequest(format!("{field} must be a canonical ISO timestamp."))
    })?;
  if canonical != value {
    return Err(StorageError::InvalidRequest(format!(
      "{field} must be a canonical ISO timestamp."
    )));
  }
  Ok(())
}

fn require_any_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, StorageError> {
  value
    .get(field)
    .and_then(Value::as_str)
    .ok_or_else(|| StorageError::InvalidRequest(format!("{field} must be a string.")))
}

fn require_boolean(value: &Value, field: &str) -> Result<bool, StorageError> {
  value
    .get(field)
    .and_then(Value::as_bool)
    .ok_or_else(|| StorageError::InvalidRequest(format!("{field} must be a boolean.")))
}

fn validate_optional_string(
  value: &Value,
  field: &str,
  allow_empty: bool,
) -> Result<(), StorageError> {
  let Some(candidate) = value.get(field) else {
    return Ok(());
  };
  let candidate = candidate.as_str().ok_or_else(|| {
    StorageError::InvalidRequest(format!("{field} must be a string when present."))
  })?;
  if !allow_empty && candidate.is_empty() {
    return Err(StorageError::InvalidRequest(format!(
      "{field} must be a non-empty string when present."
    )));
  }
  Ok(())
}

fn validate_optional_boolean(value: &Value, field: &str) -> Result<(), StorageError> {
  if value
    .get(field)
    .is_some_and(|candidate| !candidate.is_boolean())
  {
    return Err(StorageError::InvalidRequest(format!(
      "{field} must be a boolean when present."
    )));
  }
  Ok(())
}

fn require_non_negative_number(
  value: &Map<String, Value>,
  field: &str,
  label: &str,
) -> Result<(), StorageError> {
  if !value
    .get(field)
    .and_then(Value::as_f64)
    .is_some_and(|candidate| candidate.is_finite() && candidate >= 0.0)
  {
    return Err(StorageError::InvalidRequest(format!(
      "{label} {field} must be a non-negative number."
    )));
  }
  Ok(())
}
