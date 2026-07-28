use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

use crate::protocol::{WorkspaceChangeKind, WorkspaceHandle};

use super::{
  super::{StorageError, StorageService, json_string},
  receipts::parse_change_record,
  repository::{
    assert_workspace_handle, has_descendants, has_file_ancestor,
    invalidate_related_missing_revisions, next_revision, read_file, validate_identifier,
  },
};

impl StorageService {
  pub(in crate::storage) fn workspace_list_changes(
    &self,
    workspace: &WorkspaceHandle,
  ) -> Result<Value, StorageError> {
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction()?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    let mut statement = transaction.prepare(
      "SELECT change_id, created_at, record_json FROM workspace_changes
       ORDER BY created_at ASC, change_id ASC",
    )?;
    let records = statement
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
        ))
      })?
      .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let changes = records
      .into_iter()
      .map(|(change_id, created_at, record)| {
        parse_change_record(&record, meta.workspace_revision, &change_id, &created_at)
      })
      .collect::<Result<Vec<_>, _>>()?;
    transaction.commit()?;
    Ok(json!({
      "workspace_revision": meta.workspace_revision,
      "changes": changes,
    }))
  }

  pub(in crate::storage) fn workspace_get_change(
    &self,
    workspace: &WorkspaceHandle,
    change_id: &str,
  ) -> Result<Value, StorageError> {
    validate_identifier(change_id, "change_id")?;
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction()?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    let stored_record: Option<(String, String, String)> = transaction
      .query_row(
        "SELECT change_id, created_at, record_json
         FROM workspace_changes WHERE change_id = ?1",
        [change_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
      )
      .optional()?;
    let change = stored_record
      .as_ref()
      .map(|(stored_change_id, created_at, record)| {
        parse_change_record(
          record,
          meta.workspace_revision,
          stored_change_id,
          created_at,
        )
      })
      .transpose()?;
    transaction.commit()?;
    Ok(json!({
      "workspace_revision": meta.workspace_revision,
      "change": change,
    }))
  }

  pub(in crate::storage) fn workspace_revert_change(
    &self,
    workspace: &WorkspaceHandle,
    change_id: &str,
  ) -> Result<Value, StorageError> {
    validate_identifier(change_id, "change_id")?;
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    let stored_record: Option<(String, String, String)> = transaction
      .query_row(
        "SELECT change_id, created_at, record_json
         FROM workspace_changes WHERE change_id = ?1",
        [change_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
      )
      .optional()?;
    let Some((stored_change_id, created_at, record_json)) = stored_record else {
      return Err(StorageError::vfs(
        "vfs_not_found",
        format!("Workspace change not found: {change_id}"),
      ));
    };
    let mut change = parse_change_record(
      &record_json,
      meta.workspace_revision,
      &stored_change_id,
      &created_at,
    )?;
    if let Some(reverted_revision) = change.reverted_at_workspace_revision {
      transaction.commit()?;
      return Ok(json!({
        "workspace_revision": meta.workspace_revision,
        "revert_outcome": "already_reverted",
        "reverted_at_workspace_revision": reverted_revision,
        "change": change,
      }));
    }
    let applied_revision = change.applied_workspace_revision.ok_or_else(|| {
      StorageError::vfs(
        "vfs_conflict",
        format!("Workspace change has no safe path revision: {change_id}"),
      )
    })?;
    let current_file = read_file(&transaction, &change.path)?;
    let path_revision: Option<u64> = transaction
      .query_row(
        "SELECT path_revision FROM workspace_path_revisions WHERE path = ?1",
        [&change.path],
        |row| row.get(0),
      )
      .optional()?;
    let current_generation = match change.change_kind {
      WorkspaceChangeKind::Deleted => {
        current_file.is_none()
          && !has_descendants(&transaction, &change.path)?
          && !has_file_ancestor(&transaction, &change.path)?
          && path_revision == Some(applied_revision)
      }
      WorkspaceChangeKind::Created | WorkspaceChangeKind::Updated => {
        current_file.as_ref().is_some_and(|file| {
          Some(file.content.as_str()) == change.after_content.as_deref()
            && file.path_revision == applied_revision
        })
      }
    };
    if !current_generation {
      return Err(StorageError::vfs(
        "vfs_conflict",
        format!(
          "Workspace path changed after receipt was created: {}",
          change.path
        ),
      ));
    }
    let revision = next_revision(meta.workspace_revision)?;
    match change.change_kind {
      WorkspaceChangeKind::Created => {
        transaction.execute(
          "DELETE FROM workspace_files WHERE path = ?1",
          [&change.path],
        )?;
      }
      WorkspaceChangeKind::Updated | WorkspaceChangeKind::Deleted => {
        let before_content = change.before_content.as_deref().ok_or_else(|| {
          StorageError::WorkspaceCorruption(format!(
            "Workspace change {change_id} has no before content."
          ))
        })?;
        transaction.execute(
          "INSERT INTO workspace_files (path, content, path_revision)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(path) DO UPDATE SET
             content = excluded.content,
             path_revision = excluded.path_revision",
          params![change.path, before_content, revision],
        )?;
      }
    }
    invalidate_related_missing_revisions(&transaction, &change.path)?;
    transaction.execute(
      "INSERT INTO workspace_path_revisions (path, path_revision)
       VALUES (?1, ?2)
       ON CONFLICT(path) DO UPDATE SET path_revision = excluded.path_revision",
      params![change.path, revision],
    )?;
    change.reverted_at_workspace_revision = Some(revision);
    transaction.execute(
      "UPDATE workspace_changes SET record_json = ?1 WHERE change_id = ?2",
      params![json_string(&serde_json::to_value(&change)?)?, change_id],
    )?;
    transaction.execute(
      "UPDATE workspace_meta SET workspace_revision = ?1 WHERE id = 1",
      [revision],
    )?;
    transaction.commit()?;
    Ok(json!({
      "workspace_revision": revision,
      "revert_outcome": "applied",
      "reverted_at_workspace_revision": revision,
      "change": change,
    }))
  }
}
