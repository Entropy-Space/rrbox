mod database;
mod dsh_session;
mod layout;
mod project_state;
mod workspace;

use std::{
  fs,
  path::{Path, PathBuf},
  sync::{Arc, Mutex},
};

use serde_json::Value;
use thiserror::Error;

use crate::protocol::{NativeStorageOperation, NativeStorageResult};

#[derive(Debug, Error)]
pub enum StorageError {
  #[error("The project store was changed by another writer.")]
  ProjectStoreConflict,
  #[error("Project workspace already exists: {0}")]
  WorkspaceAlreadyExists(String),
  #[error("Project workspace does not exist: {0}")]
  WorkspaceNotFound(String),
  #[error("{message}")]
  Vfs { code: &'static str, message: String },
  #[error("{0}")]
  WorkspaceCorruption(String),
  #[error("{0}")]
  InvalidRequest(String),
  #[error("Native storage I/O failed: {0}")]
  Io(#[from] std::io::Error),
  #[error("Native storage database failed: {0}")]
  Sqlite(#[from] rusqlite::Error),
  #[error("Native storage JSON failed: {0}")]
  Json(#[from] serde_json::Error),
  #[error("{0}")]
  Internal(String),
}

impl StorageError {
  pub fn code(&self) -> &'static str {
    match self {
      Self::ProjectStoreConflict => "project_store_conflict",
      Self::WorkspaceAlreadyExists(_) => "workspace_already_exists",
      Self::WorkspaceNotFound(_) => "workspace_not_found",
      Self::Vfs { code, .. } => code,
      Self::WorkspaceCorruption(_) => "workspace_corruption",
      Self::InvalidRequest(_) => "invalid_request",
      Self::Io(_) | Self::Sqlite(_) | Self::Json(_) | Self::Internal(_) => "internal",
    }
  }

  pub fn vfs(code: &'static str, message: impl Into<String>) -> Self {
    Self::Vfs {
      code,
      message: message.into(),
    }
  }
}

#[derive(Debug, Clone)]
pub struct StorageService {
  root: PathBuf,
  project_state_mutex: Arc<Mutex<()>>,
}

impl StorageService {
  pub fn new(root: PathBuf) -> Result<Self, StorageError> {
    Ok(Self {
      root,
      project_state_mutex: Arc::new(Mutex::new(())),
    })
  }

  pub fn initialize(&self) -> Result<(), StorageError> {
    fs::create_dir_all(self.projects_dir())?;
    fs::create_dir_all(self.staging_dir())?;
    fs::create_dir_all(self.trash_dir())?;
    self.with_project_state_lock(|| {
      self.open_or_create_catalog()?;
      self.cleanup_trash()?;
      self.recover_pending_project_save_locked()?;
      self.cleanup_unmapped_project_directories()?;
      self.cleanup_unpublished_staging()?;
      self.cleanup_trash()
    })?;
    Ok(())
  }

  pub fn execute(
    &self,
    operation: NativeStorageOperation,
  ) -> Result<NativeStorageResult, StorageError> {
    match operation {
      NativeStorageOperation::Health => Ok(NativeStorageResult::Health {
        initialized: self.catalog_path().is_file(),
      }),
      NativeStorageOperation::Initialize => {
        self.initialize()?;
        Ok(NativeStorageResult::Initialized)
      }
      NativeStorageOperation::ProjectStoreLoad => {
        let state = self.load_project_state()?;
        Ok(NativeStorageResult::ProjectStoreLoaded { state })
      }
      NativeStorageOperation::ProjectStoreSave {
        state,
        expected_revision,
      } => {
        self.save_project_state(&state, expected_revision)?;
        Ok(NativeStorageResult::ProjectStoreSaved)
      }
      NativeStorageOperation::DshSessionLoad {
        project_id,
        session_id,
      } => {
        let value = self.dsh_session_load(&project_id, &session_id)?;
        Ok(NativeStorageResult::DshSessionLoaded { value })
      }
      NativeStorageOperation::DshSessionLoadFrom {
        project_id,
        session_id,
        from_seq,
      } => {
        let value = self.dsh_session_load_from(&project_id, &session_id, from_seq)?;
        Ok(NativeStorageResult::DshSessionSuffixLoaded { value })
      }
      NativeStorageOperation::DshSessionReadRevision {
        project_id,
        session_id,
      } => {
        let value = self.dsh_session_read_revision(&project_id, &session_id)?;
        Ok(NativeStorageResult::DshSessionRevision { value })
      }
      NativeStorageOperation::DshSessionAppend {
        project_id,
        header,
        events,
        is_materialized,
      } => {
        self.dsh_session_append(&project_id, &header, &events, is_materialized)?;
        Ok(NativeStorageResult::DshSessionAppended)
      }
      NativeStorageOperation::DshSessionList { project_id } => {
        let headers = self.dsh_session_list(&project_id)?;
        Ok(NativeStorageResult::DshSessionsListed { headers })
      }
      NativeStorageOperation::DshSessionDelete {
        project_id,
        session_id,
      } => {
        self.dsh_session_delete(&project_id, &session_id)?;
        Ok(NativeStorageResult::DshSessionDeleted)
      }
      NativeStorageOperation::WorkspaceCreate {
        project_id,
        initial_files,
      } => {
        let workspace = self.workspace_create_from_wire(&project_id, initial_files.as_deref())?;
        Ok(NativeStorageResult::WorkspaceOpened { workspace })
      }
      NativeStorageOperation::WorkspaceOpen { project_id } => {
        let workspace = self.workspace_open(&project_id)?;
        Ok(NativeStorageResult::WorkspaceOpened { workspace })
      }
      NativeStorageOperation::WorkspaceDelete { project_id } => {
        self.workspace_delete(&project_id)?;
        Ok(NativeStorageResult::WorkspaceDeleted)
      }
      NativeStorageOperation::WorkspaceReconcileOrphans {
        retained_project_ids,
      } => {
        self.workspace_reconcile_orphans(&retained_project_ids)?;
        Ok(NativeStorageResult::WorkspaceOrphansReconciled)
      }
      NativeStorageOperation::WorkspaceList { workspace, path } => {
        let value = self.workspace_list(&workspace, &path)?;
        Ok(NativeStorageResult::WorkspaceListed { value })
      }
      NativeStorageOperation::WorkspaceRead { workspace, path } => {
        let value = self.workspace_read(&workspace, &path)?;
        Ok(NativeStorageResult::WorkspaceRead { value })
      }
      NativeStorageOperation::WorkspaceGetPathState { workspace, path } => {
        let value = self.workspace_get_path_state(&workspace, &path)?;
        Ok(NativeStorageResult::WorkspacePathState { value })
      }
      NativeStorageOperation::WorkspaceReadFilesSnapshot { workspace } => {
        let value = self.workspace_read_files_snapshot(&workspace)?;
        Ok(NativeStorageResult::WorkspaceFilesSnapshot { value })
      }
      NativeStorageOperation::WorkspaceWrite {
        workspace,
        path,
        content,
        options,
      } => {
        let value = self.workspace_write(&workspace, &path, &content, options.as_ref())?;
        Ok(NativeStorageResult::WorkspaceWritten { value })
      }
      NativeStorageOperation::WorkspaceRemove {
        workspace,
        path,
        options,
      } => {
        let value = self.workspace_remove(&workspace, &path, options.as_ref())?;
        Ok(NativeStorageResult::WorkspaceRemoved { value })
      }
      NativeStorageOperation::WorkspaceListChanges { workspace } => {
        let value = self.workspace_list_changes(&workspace)?;
        Ok(NativeStorageResult::WorkspaceChangesListed { value })
      }
      NativeStorageOperation::WorkspaceGetChange {
        workspace,
        change_id,
      } => {
        let value = self.workspace_get_change(&workspace, &change_id)?;
        Ok(NativeStorageResult::WorkspaceChange { value })
      }
      NativeStorageOperation::WorkspaceRevertChange {
        workspace,
        change_id,
      } => {
        let value = self.workspace_revert_change(&workspace, &change_id)?;
        Ok(NativeStorageResult::WorkspaceChangeReverted { value })
      }
      NativeStorageOperation::ProjectUsage { project_id } => {
        let value = self.project_usage(&project_id)?;
        Ok(NativeStorageResult::ProjectUsage { value })
      }
    }
  }
}

fn file_size(path: &Path) -> u64 {
  fs::metadata(path)
    .map(|metadata| metadata.len())
    .unwrap_or(0)
}

fn json_string(value: &Value) -> Result<String, StorageError> {
  Ok(serde_json::to_string(value)?)
}

#[cfg(test)]
mod tests;
