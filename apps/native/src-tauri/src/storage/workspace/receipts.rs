use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{Transaction, params};

use crate::protocol::{
  WorkspaceChangeKind, WorkspaceChangeMetadata, WorkspaceChangeRecord, WorkspaceToolName,
};

use super::{
  super::{StorageError, json_string},
  MAX_SAFE_INTEGER,
  repository::{normalize_file_path, validate_identifier},
};

pub(super) fn normalize_change_metadata(
  change: &WorkspaceChangeMetadata,
  last_change_at: Option<&str>,
) -> Result<WorkspaceChangeMetadata, StorageError> {
  for (field, value) in [
    ("change_id", change.change_id.as_str()),
    ("session_id", change.session_id.as_str()),
    ("tool_call_block_id", change.tool_call_block_id.as_str()),
    ("tool_call_id", change.tool_call_id.as_str()),
  ] {
    validate_identifier(value, field)?;
  }
  if change.assistant_message_index > MAX_SAFE_INTEGER {
    return Err(StorageError::InvalidRequest(
      "assistant_message_index exceeds the safe integer range.".into(),
    ));
  }
  let requested = DateTime::parse_from_rfc3339(&change.created_at)
    .map(|value| value.with_timezone(&Utc))
    .unwrap_or_else(|_| Utc::now());
  let previous = last_change_at
    .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    .map(|value| value.with_timezone(&Utc));
  let normalized = if let Some(previous) = previous {
    let minimum = previous
      .checked_add_signed(Duration::milliseconds(1))
      .ok_or_else(|| {
        StorageError::vfs(
          "vfs_conflict",
          "Workspace change timestamp sequence is exhausted.",
        )
      })?;
    std::cmp::max(requested, minimum)
  } else {
    requested
  };
  Ok(WorkspaceChangeMetadata {
    created_at: normalized.to_rfc3339_opts(SecondsFormat::Millis, true),
    ..change.clone()
  })
}

pub(super) fn create_change_record(
  change: WorkspaceChangeMetadata,
  path: &str,
  change_kind: WorkspaceChangeKind,
  before_content: Option<String>,
  after_content: Option<String>,
  revision: u64,
) -> WorkspaceChangeRecord {
  let (additions, deletions) = compute_line_changes(
    before_content.as_deref().unwrap_or(""),
    after_content.as_deref().unwrap_or(""),
  );
  WorkspaceChangeRecord {
    change_id: change.change_id,
    session_id: change.session_id,
    tool_call_block_id: Some(change.tool_call_block_id),
    legacy_message_id: None,
    assistant_message_index: Some(change.assistant_message_index),
    tool_call_id: change.tool_call_id,
    tool_name: change.tool_name,
    created_at: change.created_at,
    applied_workspace_revision: Some(revision),
    reverted_at_workspace_revision: None,
    path: path.to_owned(),
    change_kind,
    before_content,
    byte_size: after_content
      .as_deref()
      .map(|content| content.len() as u64)
      .unwrap_or(0),
    after_content,
    additions,
    deletions,
  }
}

fn compute_line_changes(before: &str, after: &str) -> (u64, u64) {
  let before_lines = split_lines(before);
  let after_lines = split_lines(after);
  let mut prefix = 0;
  while prefix < before_lines.len()
    && prefix < after_lines.len()
    && before_lines[prefix] == after_lines[prefix]
  {
    prefix += 1;
  }
  let mut suffix = 0;
  while suffix < before_lines.len().saturating_sub(prefix)
    && suffix < after_lines.len().saturating_sub(prefix)
    && before_lines[before_lines.len() - suffix - 1] == after_lines[after_lines.len() - suffix - 1]
  {
    suffix += 1;
  }
  (
    (after_lines.len() - prefix - suffix) as u64,
    (before_lines.len() - prefix - suffix) as u64,
  )
}

fn split_lines(content: &str) -> Vec<&str> {
  if content.is_empty() {
    Vec::new()
  } else {
    content.split_inclusive('\n').collect()
  }
}

pub(super) fn assert_change_id_available(
  transaction: &Transaction<'_>,
  change_id: &str,
) -> Result<(), StorageError> {
  let exists: bool = transaction.query_row(
    "SELECT EXISTS(
      SELECT 1 FROM workspace_changes WHERE change_id = ?1
    )",
    [change_id],
    |row| row.get(0),
  )?;
  if exists {
    return Err(StorageError::vfs(
      "vfs_conflict",
      format!("Workspace change already exists: {change_id}"),
    ));
  }
  Ok(())
}

pub(super) fn insert_change(
  transaction: &Transaction<'_>,
  change: &WorkspaceChangeRecord,
) -> Result<(), StorageError> {
  transaction.execute(
    "INSERT INTO workspace_changes (change_id, created_at, record_json)
     VALUES (?1, ?2, ?3)",
    params![
      change.change_id,
      change.created_at,
      json_string(&serde_json::to_value(change)?)?,
    ],
  )?;
  Ok(())
}

pub(super) fn parse_change_record(
  value: &str,
  workspace_revision: u64,
  stored_change_id: &str,
  stored_created_at: &str,
) -> Result<WorkspaceChangeRecord, StorageError> {
  let change: WorkspaceChangeRecord = serde_json::from_str(value).map_err(|error| {
    StorageError::WorkspaceCorruption(format!("Workspace change receipt is malformed: {error}"))
  })?;
  validate_change_record(
    &change,
    workspace_revision,
    stored_change_id,
    stored_created_at,
  )?;
  Ok(change)
}

fn validate_change_record(
  change: &WorkspaceChangeRecord,
  workspace_revision: u64,
  stored_change_id: &str,
  stored_created_at: &str,
) -> Result<(), StorageError> {
  for (field, value) in [
    ("change.change_id", change.change_id.as_str()),
    ("change.session_id", change.session_id.as_str()),
    ("change.tool_call_id", change.tool_call_id.as_str()),
  ] {
    validate_identifier(value, field)
      .map_err(|error| StorageError::WorkspaceCorruption(error.to_string()))?;
  }
  if change.change_id != stored_change_id {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt identity does not match its index row.".into(),
    ));
  }
  let canonical_created_at = DateTime::parse_from_rfc3339(&change.created_at)
    .map(|value| {
      value
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
    .map_err(|_| {
      StorageError::WorkspaceCorruption(
        "Native workspace receipt has an invalid created_at.".into(),
      )
    })?;
  if canonical_created_at != change.created_at || stored_created_at != change.created_at {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has a non-canonical or mismatched created_at.".into(),
    ));
  }
  if change
    .tool_call_block_id
    .as_deref()
    .is_some_and(str::is_empty)
    || change
      .legacy_message_id
      .as_deref()
      .is_some_and(str::is_empty)
  {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has an invalid assistant message identity.".into(),
    ));
  }
  if change.tool_call_block_id.is_none() && change.legacy_message_id.is_none() {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has no stable assistant message identity.".into(),
    ));
  }
  if change
    .assistant_message_index
    .is_some_and(|index| index > MAX_SAFE_INTEGER)
  {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has an invalid assistant message index.".into(),
    ));
  }
  let canonical_path = normalize_file_path(&change.path)
    .map_err(|error| StorageError::WorkspaceCorruption(error.to_string()))?;
  if canonical_path != change.path {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has a non-canonical path.".into(),
    ));
  }
  if workspace_revision > MAX_SAFE_INTEGER {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace has an invalid revision.".into(),
    ));
  }
  let applied = change.applied_workspace_revision.ok_or_else(|| {
    StorageError::WorkspaceCorruption("Native workspace receipt has no applied revision.".into())
  })?;
  if applied == 0 || applied > workspace_revision || applied > MAX_SAFE_INTEGER {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has an invalid applied revision.".into(),
    ));
  }
  if change
    .reverted_at_workspace_revision
    .is_some_and(|revision| {
      revision <= applied || revision > workspace_revision || revision > MAX_SAFE_INTEGER
    })
  {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has an invalid revert revision.".into(),
    ));
  }
  let expected_tool = match change.change_kind {
    WorkspaceChangeKind::Created => change.tool_name == WorkspaceToolName::WriteFile,
    WorkspaceChangeKind::Updated => {
      matches!(
        change.tool_name,
        WorkspaceToolName::WriteFile | WorkspaceToolName::ReplaceText
      )
    }
    WorkspaceChangeKind::Deleted => change.tool_name == WorkspaceToolName::RemoveFile,
  };
  if !expected_tool {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has an inconsistent tool name.".into(),
    ));
  }
  let content_shape_is_valid = match change.change_kind {
    WorkspaceChangeKind::Created => {
      change.before_content.is_none() && change.after_content.is_some()
    }
    WorkspaceChangeKind::Updated => {
      change.before_content.is_some() && change.after_content.is_some()
    }
    WorkspaceChangeKind::Deleted => {
      change.before_content.is_some() && change.after_content.is_none()
    }
  };
  if !content_shape_is_valid || change.before_content == change.after_content {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has inconsistent content.".into(),
    ));
  }
  let (additions, deletions) = compute_line_changes(
    change.before_content.as_deref().unwrap_or(""),
    change.after_content.as_deref().unwrap_or(""),
  );
  let byte_size = change
    .after_content
    .as_deref()
    .map(|content| content.len() as u64)
    .unwrap_or(0);
  if change.additions != additions || change.deletions != deletions || change.byte_size != byte_size
  {
    return Err(StorageError::WorkspaceCorruption(
      "Native workspace receipt has invalid derived metadata.".into(),
    ));
  }
  Ok(())
}
