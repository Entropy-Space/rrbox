use std::{
  fs::{self, File},
  path::Path,
  time::Duration,
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use uuid::Uuid;

use super::{StorageError, StorageService};

const CATALOG_SCHEMA_VERSION: u32 = 1;
const PROJECT_SCHEMA_VERSION: u32 = 2;

impl StorageService {
  pub(super) fn open_catalog(&self) -> Result<Connection, StorageError> {
    let path = self.catalog_path();
    if !path.is_file() {
      return Err(StorageError::WorkspaceCorruption(
        "The native project catalog is missing.".into(),
      ));
    }
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    validate_schema_version(
      &connection,
      CATALOG_SCHEMA_VERSION,
      "native project catalog",
    )?;
    configure_connection(&connection)?;
    Ok(connection)
  }

  pub(super) fn open_or_create_catalog(&self) -> Result<Connection, StorageError> {
    let final_path = self.catalog_path();
    if final_path.exists() {
      return self.open_catalog();
    }

    let staged_path = self
      .staging_dir()
      .join(format!("catalog-{}.sqlite3", Uuid::new_v4().simple()));
    let mut connection = Connection::open_with_flags(
      &staged_path,
      OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    configure_connection(&connection)?;
    self.initialize_catalog_schema(&mut connection)?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    drop(connection);
    sync_file_and_parent(&staged_path)?;
    fs::rename(&staged_path, &final_path)?;
    sync_directory(&self.root)?;
    self.open_catalog()
  }

  pub(super) fn open_project_database(&self, storage_id: &str) -> Result<Connection, StorageError> {
    let path = self.project_database_path(storage_id)?;
    if !path.is_file() {
      return Err(StorageError::WorkspaceCorruption(format!(
        "Native project database {storage_id} is missing."
      )));
    }
    let mut connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    configure_connection(&connection)?;
    self.migrate_project_schema(&mut connection)?;
    validate_schema_version(
      &connection,
      PROJECT_SCHEMA_VERSION,
      "native project database",
    )?;
    Ok(connection)
  }

  pub(super) fn open_or_create_unpublished_project_database(
    &self,
    storage_id: &str,
  ) -> Result<Connection, StorageError> {
    validate_opaque_id(storage_id, "storage_id")?;
    let final_directory = self.project_dir(storage_id)?;
    let final_database = final_directory.join("project.sqlite3");
    if final_directory.exists() {
      if !final_database.is_file() {
        return Err(StorageError::WorkspaceCorruption(format!(
          "Unpublished native project database {storage_id} is incomplete."
        )));
      }
      return self.open_project_database(storage_id);
    }

    let staged_directory = self.staging_dir().join(format!("project-{storage_id}"));
    if staged_directory.exists() {
      if staged_directory.is_dir() {
        fs::remove_dir_all(&staged_directory)?;
      } else {
        fs::remove_file(&staged_directory)?;
      }
      sync_directory(&self.staging_dir())?;
    }
    fs::create_dir(&staged_directory)?;
    sync_directory(&self.staging_dir())?;
    let staged_database = staged_directory.join("project.sqlite3");
    let mut connection = Connection::open_with_flags(
      &staged_database,
      OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    configure_connection(&connection)?;
    self.initialize_project_schema(&mut connection)?;
    connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    drop(connection);
    sync_file_and_parent(&staged_database)?;
    fs::rename(&staged_directory, &final_directory)?;
    sync_directory(&self.staging_dir())?;
    sync_directory(&self.projects_dir())?;
    self.open_project_database(storage_id)
  }

  fn initialize_catalog_schema(&self, connection: &mut Connection) -> Result<(), StorageError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
      "
      CREATE TABLE IF NOT EXISTS native_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project_schema_version INTEGER,
        state_revision INTEGER,
        active_project_id TEXT,
        active_session_id TEXT
      );
      INSERT OR IGNORE INTO catalog_state (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS project_storage (
        project_id TEXT PRIMARY KEY COLLATE BINARY,
        storage_id TEXT NOT NULL UNIQUE,
        project_ordinal INTEGER,
        in_project_state INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pending_project_commit (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        commit_id TEXT NOT NULL,
        mappings_json TEXT NOT NULL
      );
      ",
    )?;
    transaction.execute(
      "INSERT INTO native_meta (key, value) VALUES ('schema_version', ?1)",
      [CATALOG_SCHEMA_VERSION.to_string()],
    )?;
    transaction.commit()?;
    Ok(())
  }

  fn initialize_project_schema(&self, connection: &mut Connection) -> Result<(), StorageError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
      "
      CREATE TABLE IF NOT EXISTS native_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project_json TEXT
      );
      INSERT OR IGNORE INTO project_state (id, project_json) VALUES (1, NULL);
      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY COLLATE BINARY,
        session_ordinal INTEGER NOT NULL,
        session_json TEXT NOT NULL,
        document_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dsh_session_headers (
        session_id TEXT PRIMARY KEY COLLATE BINARY,
        header_json TEXT NOT NULL,
        storage_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dsh_session_events (
        session_id TEXT NOT NULL COLLATE BINARY,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES dsh_session_headers(session_id)
          ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS workspace_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active INTEGER NOT NULL,
        incarnation_id TEXT,
        workspace_revision INTEGER NOT NULL,
        last_change_at TEXT
      );
      INSERT OR IGNORE INTO workspace_meta (
        id, active, incarnation_id, workspace_revision, last_change_at
      ) VALUES (1, 0, NULL, 0, NULL);
      CREATE TABLE IF NOT EXISTS workspace_files (
        path TEXT PRIMARY KEY COLLATE BINARY,
        content TEXT NOT NULL,
        path_revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_path_revisions (
        path TEXT PRIMARY KEY COLLATE BINARY,
        path_revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_changes (
        change_id TEXT PRIMARY KEY COLLATE BINARY,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      ",
    )?;
    transaction.execute(
      "INSERT INTO native_meta (key, value) VALUES ('schema_version', ?1)",
      [PROJECT_SCHEMA_VERSION.to_string()],
    )?;
    transaction.commit()?;
    Ok(())
  }

  fn migrate_project_schema(&self, connection: &mut Connection) -> Result<(), StorageError> {
    let version = read_schema_version(connection, "native project database")?;
    if version == PROJECT_SCHEMA_VERSION {
      return Ok(());
    }
    if version != 1 {
      return Err(StorageError::WorkspaceCorruption(format!(
        "Unsupported native project database schema version {version}; expected {PROJECT_SCHEMA_VERSION}."
      )));
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let locked_version = read_schema_version(&transaction, "native project database")?;
    if locked_version == PROJECT_SCHEMA_VERSION {
      transaction.commit()?;
      return Ok(());
    }
    if locked_version != 1 {
      return Err(StorageError::WorkspaceCorruption(format!(
        "Unsupported native project database schema version {locked_version}; expected {PROJECT_SCHEMA_VERSION}."
      )));
    }
    transaction.execute_batch(
      "
      CREATE TABLE dsh_session_headers (
        session_id TEXT PRIMARY KEY COLLATE BINARY,
        header_json TEXT NOT NULL,
        storage_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_count INTEGER NOT NULL
      );
      CREATE TABLE dsh_session_events (
        session_id TEXT NOT NULL COLLATE BINARY,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES dsh_session_headers(session_id)
          ON DELETE CASCADE
      );
      ",
    )?;
    transaction.execute(
      "UPDATE native_meta SET value = ?1 WHERE key = 'schema_version'",
      [PROJECT_SCHEMA_VERSION.to_string()],
    )?;
    transaction.commit()?;
    Ok(())
  }

  pub(super) fn storage_id_for_project(
    &self,
    project_id: &str,
  ) -> Result<Option<String>, StorageError> {
    if project_id.is_empty() {
      return Err(StorageError::InvalidRequest(
        "project_id must be a non-empty string.".into(),
      ));
    }
    let catalog = self.open_catalog()?;
    let storage_id: Option<String> = catalog
      .query_row(
        "SELECT storage_id FROM project_storage WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
      )
      .optional()
      .map_err(StorageError::from)?;
    if let Some(storage_id) = &storage_id {
      validate_opaque_id(storage_id, "catalog storage_id")?;
    }
    Ok(storage_id)
  }

  pub(super) fn ensure_project_storage(&self, project_id: &str) -> Result<String, StorageError> {
    if let Some(storage_id) = self.storage_id_for_project(project_id)? {
      self.open_project_database(&storage_id)?;
      return Ok(storage_id);
    }
    let storage_id = Uuid::new_v4().simple().to_string();
    self.open_or_create_unpublished_project_database(&storage_id)?;
    let mut catalog = self.open_catalog()?;
    let transaction = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<String> = transaction
      .query_row(
        "SELECT storage_id FROM project_storage WHERE project_id = ?1",
        [project_id],
        |row| row.get(0),
      )
      .optional()?;
    let effective_storage_id = if let Some(existing) = existing {
      existing
    } else {
      transaction.execute(
        "INSERT INTO project_storage (
          project_id, storage_id, project_ordinal, in_project_state
        ) VALUES (?1, ?2, NULL, 0)",
        params![project_id, &storage_id],
      )?;
      storage_id.clone()
    };
    transaction.commit()?;
    if effective_storage_id != storage_id {
      self.open_project_database(&effective_storage_id)?;
    }
    Ok(effective_storage_id)
  }

  pub(super) fn project_connection(&self, project_id: &str) -> Result<Connection, StorageError> {
    let storage_id = self
      .storage_id_for_project(project_id)?
      .ok_or_else(|| StorageError::WorkspaceNotFound(project_id.to_owned()))?;
    self.open_project_database(&storage_id)
  }
}

fn configure_connection(connection: &Connection) -> Result<(), StorageError> {
  connection.busy_timeout(Duration::from_secs(5))?;
  connection.execute_batch(
    "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    ",
  )?;
  Ok(())
}

fn validate_schema_version(
  connection: &Connection,
  expected: u32,
  label: &str,
) -> Result<(), StorageError> {
  let version = read_schema_version(connection, label)?;
  if version != expected {
    return Err(StorageError::WorkspaceCorruption(format!(
      "Unsupported {label} schema version {version}; expected {expected}."
    )));
  }
  Ok(())
}

fn read_schema_version(connection: &Connection, label: &str) -> Result<u32, StorageError> {
  let stored: String = connection
    .query_row(
      "SELECT value FROM native_meta WHERE key = 'schema_version'",
      [],
      |row| row.get(0),
    )
    .map_err(|error| {
      StorageError::WorkspaceCorruption(format!(
        "The {label} has no readable schema version: {error}"
      ))
    })?;
  let version = stored.parse::<u32>().map_err(|_| {
    StorageError::WorkspaceCorruption(format!(
      "The {label} has an invalid schema version: {stored}."
    ))
  })?;
  Ok(version)
}

pub(super) fn validate_opaque_id(value: &str, field: &str) -> Result<(), StorageError> {
  if value.len() != 32
    || !value
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
  {
    return Err(StorageError::WorkspaceCorruption(format!(
      "{field} is not a valid native storage identifier."
    )));
  }
  Ok(())
}

fn sync_file_and_parent(path: &Path) -> Result<(), StorageError> {
  File::open(path)?.sync_all()?;
  if let Some(parent) = path.parent() {
    sync_directory(parent)?;
  }
  Ok(())
}

pub(super) fn sync_directory(path: &Path) -> Result<(), StorageError> {
  #[cfg(unix)]
  File::open(path)?.sync_all()?;
  #[cfg(not(unix))]
  let _ = path;
  Ok(())
}
