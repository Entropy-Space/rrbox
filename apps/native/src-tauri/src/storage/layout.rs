use std::{
  collections::HashSet,
  fs::{self, File, OpenOptions},
  path::PathBuf,
};

use fs2::FileExt;

use super::{
  StorageError, StorageService,
  database::{sync_directory, validate_opaque_id},
};

impl StorageService {
  pub(super) fn catalog_path(&self) -> PathBuf {
    self.root.join("catalog.sqlite3")
  }

  pub(super) fn projects_dir(&self) -> PathBuf {
    self.root.join("projects")
  }

  pub(super) fn staging_dir(&self) -> PathBuf {
    self.root.join("staging")
  }

  pub(super) fn trash_dir(&self) -> PathBuf {
    self.root.join("trash")
  }

  fn project_state_lock_path(&self) -> PathBuf {
    self.root.join("project-state.lock")
  }

  pub(super) fn staging_journal_path(&self, commit_id: &str) -> Result<PathBuf, StorageError> {
    validate_opaque_id(commit_id, "commit_id")?;
    Ok(self.staging_dir().join(format!("{commit_id}.json")))
  }

  pub(super) fn project_dir(&self, storage_id: &str) -> Result<PathBuf, StorageError> {
    validate_opaque_id(storage_id, "storage_id")?;
    Ok(self.projects_dir().join(storage_id))
  }

  pub(super) fn project_database_path(&self, storage_id: &str) -> Result<PathBuf, StorageError> {
    Ok(self.project_dir(storage_id)?.join("project.sqlite3"))
  }

  pub(super) fn cleanup_unpublished_staging(&self) -> Result<(), StorageError> {
    for entry in fs::read_dir(self.staging_dir())? {
      let entry = entry?;
      let path = entry.path();
      if path.is_dir() {
        fs::remove_dir_all(path)?;
      } else {
        fs::remove_file(path)?;
      }
    }
    sync_directory(&self.staging_dir())?;
    Ok(())
  }

  pub(super) fn cleanup_unmapped_project_directories(&self) -> Result<(), StorageError> {
    let catalog = self.open_catalog()?;
    let mut statement = catalog.prepare("SELECT storage_id FROM project_storage")?;
    let mapped_storage_ids = statement
      .query_map([], |row| row.get::<_, String>(0))?
      .collect::<Result<HashSet<_>, _>>()?;
    drop(statement);
    drop(catalog);
    for storage_id in &mapped_storage_ids {
      validate_opaque_id(storage_id, "catalog storage_id")?;
      let project_directory = self.project_dir(storage_id)?;
      let project_database = project_directory.join("project.sqlite3");
      if !project_directory.is_dir() || !project_database.is_file() {
        return Err(StorageError::WorkspaceCorruption(format!(
          "Mapped native project database {storage_id} is missing."
        )));
      }
    }

    for entry in fs::read_dir(self.projects_dir())? {
      let entry = entry?;
      let file_type = entry.file_type()?;
      let storage_id = entry.file_name().into_string().map_err(|_| {
        StorageError::WorkspaceCorruption(
          "Native project storage contains a non-Unicode directory name.".into(),
        )
      })?;
      validate_opaque_id(&storage_id, "project directory name")?;
      if !file_type.is_dir() {
        return Err(StorageError::WorkspaceCorruption(format!(
          "Native project storage entry {storage_id} is not a directory."
        )));
      }
      if mapped_storage_ids.contains(&storage_id) {
        continue;
      }
      let trash_path = self.trash_dir().join(&storage_id);
      fs::rename(entry.path(), &trash_path)?;
      sync_directory(&self.projects_dir())?;
      sync_directory(&self.trash_dir())?;
    }
    Ok(())
  }

  pub(super) fn cleanup_trash(&self) -> Result<(), StorageError> {
    for entry in fs::read_dir(self.trash_dir())? {
      let entry = entry?;
      let path = entry.path();
      if entry.file_type()?.is_dir() {
        fs::remove_dir_all(path)?;
      } else {
        fs::remove_file(path)?;
      }
    }
    sync_directory(&self.trash_dir())?;
    Ok(())
  }

  pub(super) fn with_project_state_lock<T>(
    &self,
    operation: impl FnOnce() -> Result<T, StorageError>,
  ) -> Result<T, StorageError> {
    let _process_guard = self
      .project_state_mutex
      .lock()
      .map_err(|_| StorageError::Internal("The project state lock was poisoned.".into()))?;
    let lock_file = self.open_project_state_lock_file()?;
    lock_file.lock_exclusive()?;
    let result = operation();
    let unlock_result = lock_file.unlock();
    match (result, unlock_result) {
      (Ok(value), Ok(())) => Ok(value),
      (Err(error), _) => Err(error),
      (Ok(_), Err(error)) => Err(StorageError::Io(error)),
    }
  }

  fn open_project_state_lock_file(&self) -> Result<File, StorageError> {
    Ok(
      OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(self.project_state_lock_path())?,
    )
  }
}
