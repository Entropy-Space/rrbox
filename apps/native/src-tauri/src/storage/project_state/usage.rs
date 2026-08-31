use crate::protocol::{ProjectUsage, ProjectUsageBreakdown};

use super::super::{StorageError, StorageService, file_size};

impl StorageService {
  pub(in crate::storage) fn project_usage(
    &self,
    project_id: &str,
  ) -> Result<ProjectUsage, StorageError> {
    self.with_project_state_lock(|| {
      self.recover_pending_project_save_locked()?;
      self.project_usage_locked(project_id)
    })
  }

  fn project_usage_locked(&self, project_id: &str) -> Result<ProjectUsage, StorageError> {
    let storage_id = self
      .storage_id_for_project(project_id)?
      .ok_or_else(|| StorageError::WorkspaceNotFound(project_id.to_owned()))?;
    let mut connection = self.open_project_database(&storage_id)?;
    let transaction = connection.transaction()?;
    let project_bytes: u64 = transaction.query_row(
      "SELECT COALESCE(length(CAST(project_json AS BLOB)), 0)
       FROM project_state WHERE id = 1",
      [],
      |row| row.get(0),
    )?;
    let host_conversation_bytes: u64 = transaction.query_row(
      "SELECT COALESCE(SUM(
        length(CAST(session_json AS BLOB)) +
        length(CAST(document_json AS BLOB))
      ), 0) FROM session_state",
      [],
      |row| row.get(0),
    )?;
    let dsh_header_bytes: u64 = transaction.query_row(
      "SELECT COALESCE(SUM(length(CAST(header_json AS BLOB))), 0)
       FROM dsh_session_headers",
      [],
      |row| row.get(0),
    )?;
    let dsh_event_bytes: u64 = transaction.query_row(
      "SELECT COALESCE(SUM(length(CAST(event_json AS BLOB))), 0)
       FROM dsh_session_events",
      [],
      |row| row.get(0),
    )?;
    let conversation_bytes = host_conversation_bytes
      .saturating_add(dsh_header_bytes)
      .saturating_add(dsh_event_bytes);
    let workspace_bytes: u64 = transaction.query_row(
      "SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0)
       FROM workspace_files",
      [],
      |row| row.get(0),
    )?;
    let history_bytes: u64 = transaction.query_row(
      "SELECT COALESCE(SUM(length(CAST(record_json AS BLOB))), 0)
       FROM workspace_changes",
      [],
      |row| row.get(0),
    )?;
    let page_size: u64 = transaction.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    let page_count: u64 = transaction.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    let database_bytes = page_size.saturating_mul(page_count);
    let logical_bytes = project_bytes
      .saturating_add(conversation_bytes)
      .saturating_add(workspace_bytes)
      .saturating_add(history_bytes);
    transaction.commit()?;
    drop(connection);

    let database_path = self.project_database_path(&storage_id)?;
    let disk_bytes = file_size(&database_path)
      .saturating_add(file_size(&database_path.with_extension("sqlite3-wal")))
      .saturating_add(file_size(&database_path.with_extension("sqlite3-shm")));
    Ok(ProjectUsage {
      logical_bytes,
      database_bytes,
      disk_bytes,
      breakdown: ProjectUsageBreakdown {
        workspace_bytes,
        conversation_bytes: project_bytes.saturating_add(conversation_bytes),
        history_bytes,
        database_overhead_bytes: database_bytes.saturating_sub(logical_bytes),
      },
    })
  }
}
