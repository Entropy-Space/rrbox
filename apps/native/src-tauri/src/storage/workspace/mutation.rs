use rusqlite::{TransactionBehavior, params};
use serde_json::{Value, json};

use crate::protocol::{
  ExpectedContent, WorkspaceChangeKind, WorkspaceHandle, WorkspaceRemoveOptions, WorkspaceToolName,
  WorkspaceWriteOptions,
};

use super::{
  super::{StorageError, StorageService},
  receipts::{
    assert_change_id_available, create_change_record, insert_change, normalize_change_metadata,
  },
  repository::{
    assert_workspace_handle, assert_writable_path, has_descendants,
    invalidate_related_missing_revisions, next_revision, normalize_file_path, read_file,
  },
};

impl StorageService {
  pub(in crate::storage) fn workspace_write(
    &self,
    workspace: &WorkspaceHandle,
    path: &str,
    content: &str,
    options: Option<&WorkspaceWriteOptions>,
  ) -> Result<Value, StorageError> {
    let normalized_path = normalize_file_path(path)?;
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    assert_writable_path(&transaction, &normalized_path)?;
    let before_content = read_file(&transaction, &normalized_path)?.map(|file| file.content);
    if let Some(options) = options {
      match &options.expected_content {
        ExpectedContent::Unspecified => {}
        ExpectedContent::Exact(expected) if expected == &before_content => {}
        ExpectedContent::Exact(_) => {
          return Err(StorageError::vfs(
            "vfs_conflict",
            format!("File changed before the write could be applied: {normalized_path}"),
          ));
        }
      }
    }
    let normalized_change = options
      .and_then(|options| options.change.as_ref())
      .map(|change| normalize_change_metadata(change, meta.last_change_at.as_deref()))
      .transpose()?;
    if normalized_change
      .as_ref()
      .is_some_and(|change| change.tool_name == WorkspaceToolName::RemoveFile)
    {
      return Err(StorageError::vfs(
        "vfs_conflict",
        "A remove_file receipt cannot journal a file write.",
      ));
    }
    if before_content.is_none()
      && normalized_change
        .as_ref()
        .is_some_and(|change| change.tool_name == WorkspaceToolName::ReplaceText)
    {
      return Err(StorageError::vfs(
        "vfs_conflict",
        "A replace_text receipt cannot journal a file creation.",
      ));
    }
    if before_content.as_deref() == Some(content) {
      transaction.commit()?;
      return Ok(json!({
        "workspace_revision": meta.workspace_revision,
        "result": {
          "path": normalized_path,
          "change_kind": "unchanged",
          "before_content": before_content,
          "after_content": content,
          "change": null,
        },
      }));
    }
    if let Some(change) = &normalized_change {
      assert_change_id_available(&transaction, &change.change_id)?;
    }
    let revision = next_revision(meta.workspace_revision)?;
    let change_kind = if before_content.is_none() {
      WorkspaceChangeKind::Created
    } else {
      WorkspaceChangeKind::Updated
    };
    let receipt = normalized_change.map(|change| {
      create_change_record(
        change,
        &normalized_path,
        change_kind,
        before_content.clone(),
        Some(content.to_owned()),
        revision,
      )
    });
    transaction.execute(
      "INSERT INTO workspace_files (path, content, path_revision)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(path) DO UPDATE SET
         content = excluded.content,
         path_revision = excluded.path_revision",
      params![normalized_path, content, revision],
    )?;
    invalidate_related_missing_revisions(&transaction, &normalized_path)?;
    transaction.execute(
      "INSERT INTO workspace_path_revisions (path, path_revision)
       VALUES (?1, ?2)
       ON CONFLICT(path) DO UPDATE SET path_revision = excluded.path_revision",
      params![normalized_path, revision],
    )?;
    if let Some(receipt) = &receipt {
      insert_change(&transaction, receipt)?;
    }
    transaction.execute(
      "UPDATE workspace_meta SET
        workspace_revision = ?1,
        last_change_at = COALESCE(?2, last_change_at)
       WHERE id = 1",
      params![
        revision,
        receipt.as_ref().map(|change| change.created_at.as_str()),
      ],
    )?;
    transaction.commit()?;
    Ok(json!({
      "workspace_revision": revision,
      "result": {
        "path": normalized_path,
        "change_kind": change_kind,
        "before_content": before_content,
        "after_content": content,
        "change": receipt,
      },
    }))
  }

  pub(in crate::storage) fn workspace_remove(
    &self,
    workspace: &WorkspaceHandle,
    path: &str,
    options: Option<&WorkspaceRemoveOptions>,
  ) -> Result<Value, StorageError> {
    let normalized_path = normalize_file_path(path)?;
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    let Some(file) = read_file(&transaction, &normalized_path)? else {
      if has_descendants(&transaction, &normalized_path)? {
        return Err(StorageError::vfs(
          "vfs_is_directory",
          format!("Cannot remove a directory as a file: {normalized_path}"),
        ));
      }
      return Err(StorageError::vfs(
        "vfs_not_found",
        format!("File not found: {normalized_path}"),
      ));
    };
    if options
      .and_then(|options| options.expected_content.as_deref())
      .is_some_and(|expected| expected != file.content)
    {
      return Err(StorageError::vfs(
        "vfs_conflict",
        format!("File changed before it could be removed: {normalized_path}"),
      ));
    }
    let normalized_change = options
      .and_then(|options| options.change.as_ref())
      .map(|change| normalize_change_metadata(change, meta.last_change_at.as_deref()))
      .transpose()?;
    if normalized_change
      .as_ref()
      .is_some_and(|change| change.tool_name != WorkspaceToolName::RemoveFile)
    {
      return Err(StorageError::vfs(
        "vfs_conflict",
        "A file removal requires a remove_file receipt.",
      ));
    }
    if let Some(change) = &normalized_change {
      assert_change_id_available(&transaction, &change.change_id)?;
    }
    let revision = next_revision(meta.workspace_revision)?;
    let receipt = normalized_change.map(|change| {
      create_change_record(
        change,
        &normalized_path,
        WorkspaceChangeKind::Deleted,
        Some(file.content.clone()),
        None,
        revision,
      )
    });
    transaction.execute(
      "DELETE FROM workspace_files WHERE path = ?1",
      [&normalized_path],
    )?;
    invalidate_related_missing_revisions(&transaction, &normalized_path)?;
    transaction.execute(
      "INSERT INTO workspace_path_revisions (path, path_revision)
       VALUES (?1, ?2)
       ON CONFLICT(path) DO UPDATE SET path_revision = excluded.path_revision",
      params![normalized_path, revision],
    )?;
    if let Some(receipt) = &receipt {
      insert_change(&transaction, receipt)?;
    }
    transaction.execute(
      "UPDATE workspace_meta SET
        workspace_revision = ?1,
        last_change_at = COALESCE(?2, last_change_at)
       WHERE id = 1",
      params![
        revision,
        receipt.as_ref().map(|change| change.created_at.as_str()),
      ],
    )?;
    transaction.commit()?;
    let mut response = serde_json::Map::new();
    response.insert("workspace_revision".into(), json!(revision));
    if let Some(receipt) = receipt {
      response.insert(
        "result".into(),
        json!({
          "path": normalized_path,
          "change_kind": "deleted",
          "before_content": file.content,
          "after_content": null,
          "change": receipt,
        }),
      );
    }
    Ok(Value::Object(response))
  }
}
