use std::collections::HashSet;

use rusqlite::{TransactionBehavior, params};
use serde_json::Value;
use uuid::Uuid;

#[cfg(test)]
use crate::protocol::VfsSeedFile;
use crate::protocol::WorkspaceHandle;

#[cfg(test)]
use super::repository::normalize_initial_files;
use super::{
  super::{StorageError, StorageService},
  InitialFileSource,
  repository::{
    next_revision, normalize_wire_initial_files, read_workspace_meta,
    read_workspace_meta_connection, validate_identifier,
  },
};

impl StorageService {
  #[cfg(test)]
  pub(in crate::storage) fn workspace_create(
    &self,
    project_id: &str,
    initial_files: Option<&[VfsSeedFile]>,
  ) -> Result<WorkspaceHandle, StorageError> {
    self.workspace_create_with_source(
      project_id,
      InitialFileSource::Typed(initial_files.unwrap_or(&[])),
    )
  }

  pub(in crate::storage) fn workspace_create_from_wire(
    &self,
    project_id: &str,
    initial_files: Option<&[Value]>,
  ) -> Result<WorkspaceHandle, StorageError> {
    self.workspace_create_with_source(
      project_id,
      InitialFileSource::Wire(initial_files.unwrap_or(&[])),
    )
  }

  fn workspace_create_with_source(
    &self,
    project_id: &str,
    initial_files: InitialFileSource<'_>,
  ) -> Result<WorkspaceHandle, StorageError> {
    self.with_project_state_lock(|| {
      self.recover_pending_project_save_locked()?;
      self.workspace_create_locked(project_id, initial_files)
    })
  }

  fn workspace_create_locked(
    &self,
    project_id: &str,
    initial_files: InitialFileSource<'_>,
  ) -> Result<WorkspaceHandle, StorageError> {
    validate_identifier(project_id, "project_id")?;
    let storage_id = self.ensure_project_storage(project_id)?;
    let mut connection = self.open_project_database(&storage_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let meta = read_workspace_meta(&transaction)?;
    if meta.active {
      return Err(StorageError::WorkspaceAlreadyExists(project_id.to_owned()));
    }
    let files = match initial_files {
      #[cfg(test)]
      InitialFileSource::Typed(files) => normalize_initial_files(files)?,
      InitialFileSource::Wire(files) => normalize_wire_initial_files(files)?,
    };
    let incarnation_id = Uuid::new_v4().to_string();
    transaction.execute("DELETE FROM workspace_files", [])?;
    transaction.execute("DELETE FROM workspace_path_revisions", [])?;
    transaction.execute("DELETE FROM workspace_changes", [])?;
    for file in files {
      transaction.execute(
        "INSERT INTO workspace_files (path, content, path_revision)
         VALUES (?1, ?2, ?3)",
        params![file.path, file.content, meta.workspace_revision],
      )?;
      transaction.execute(
        "INSERT INTO workspace_path_revisions (path, path_revision)
         VALUES (?1, ?2)",
        params![file.path, meta.workspace_revision],
      )?;
    }
    transaction.execute(
      "UPDATE workspace_meta SET
        active = 1,
        incarnation_id = ?1,
        last_change_at = NULL
       WHERE id = 1",
      [&incarnation_id],
    )?;
    transaction.commit()?;
    Ok(WorkspaceHandle {
      project_id: project_id.to_owned(),
      incarnation_id,
    })
  }

  pub(in crate::storage) fn workspace_open(
    &self,
    project_id: &str,
  ) -> Result<WorkspaceHandle, StorageError> {
    self.with_project_state_lock(|| {
      self.recover_pending_project_save_locked()?;
      self.workspace_open_locked(project_id)
    })
  }

  fn workspace_open_locked(&self, project_id: &str) -> Result<WorkspaceHandle, StorageError> {
    validate_identifier(project_id, "project_id")?;
    let connection = self.project_connection(project_id)?;
    let meta = read_workspace_meta_connection(&connection)?;
    if !meta.active {
      return Err(StorageError::WorkspaceNotFound(project_id.to_owned()));
    }
    let incarnation_id = meta.incarnation_id.ok_or_else(|| {
      StorageError::WorkspaceCorruption(format!(
        "Active workspace {project_id} has no incarnation identifier."
      ))
    })?;
    Ok(WorkspaceHandle {
      project_id: project_id.to_owned(),
      incarnation_id,
    })
  }

  pub(in crate::storage) fn workspace_delete(&self, project_id: &str) -> Result<(), StorageError> {
    self.with_project_state_lock(|| {
      self.recover_pending_project_save_locked()?;
      self.workspace_delete_locked(project_id, false)
    })
  }

  fn workspace_delete_locked(
    &self,
    project_id: &str,
    preserve_published_project: bool,
  ) -> Result<(), StorageError> {
    validate_identifier(project_id, "project_id")?;
    let Some(storage_id) = self.storage_id_for_project(project_id)? else {
      return Ok(());
    };
    let catalog = self.open_catalog()?;
    let in_project_state: bool = catalog.query_row(
      "SELECT in_project_state FROM project_storage WHERE project_id = ?1",
      [project_id],
      |row| row.get(0),
    )?;
    drop(catalog);
    if preserve_published_project && in_project_state {
      return Ok(());
    }
    let mut connection = self.open_project_database(&storage_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let meta = read_workspace_meta(&transaction)?;
    if meta.active {
      let revision = next_revision(meta.workspace_revision)?;
      transaction.execute("DELETE FROM workspace_files", [])?;
      transaction.execute("DELETE FROM workspace_path_revisions", [])?;
      transaction.execute("DELETE FROM workspace_changes", [])?;
      transaction.execute(
        "UPDATE workspace_meta SET
          active = 0,
          incarnation_id = NULL,
          workspace_revision = ?1,
          last_change_at = NULL
         WHERE id = 1",
        [revision],
      )?;
    }
    if !in_project_state {
      transaction.execute(
        "UPDATE project_state SET project_json = NULL WHERE id = 1",
        [],
      )?;
      transaction.execute("DELETE FROM session_state", [])?;
    }
    transaction.commit()?;
    Ok(())
  }

  pub(in crate::storage) fn workspace_reconcile_orphans(
    &self,
    retained_project_ids: &[String],
  ) -> Result<(), StorageError> {
    let retained = retained_project_ids
      .iter()
      .map(|project_id| {
        validate_identifier(project_id, "retained_project_ids entry")?;
        Ok(project_id.as_str())
      })
      .collect::<Result<HashSet<_>, StorageError>>()?;
    self.with_project_state_lock(|| {
      self.recover_pending_project_save_locked()?;
      let catalog = self.open_catalog()?;
      let mut statement = catalog.prepare("SELECT project_id FROM project_storage")?;
      let project_ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
      drop(statement);
      drop(catalog);
      for project_id in project_ids {
        if !retained.contains(project_id.as_str()) {
          self.workspace_delete_locked(&project_id, true)?;
        }
      }
      Ok(())
    })
  }
}
