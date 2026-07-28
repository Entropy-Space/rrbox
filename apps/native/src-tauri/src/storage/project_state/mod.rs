mod usage;
mod validation;

use std::{
  collections::{HashMap, HashSet},
  fs::{self, File},
  io::Write,
};

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::protocol::require_string;

use self::validation::{MAX_SAFE_INTEGER, validate_project_state};
use super::{StorageError, StorageService, json_string};

impl StorageService {
  pub(super) fn load_project_state(&self) -> Result<Option<Value>, StorageError> {
    self.with_project_state_lock(|| {
      self.recover_pending_project_save_locked()?;
      self.load_project_state_locked()
    })
  }

  fn load_project_state_locked(&self) -> Result<Option<Value>, StorageError> {
    let catalog = self.open_catalog()?;
    let global = catalog.query_row(
      "SELECT project_schema_version, state_revision, active_project_id,
        active_session_id
       FROM catalog_state WHERE id = 1",
      [],
      |row| {
        Ok((
          row.get::<_, Option<u64>>(0)?,
          row.get::<_, Option<u64>>(1)?,
          row.get::<_, Option<String>>(2)?,
          row.get::<_, Option<String>>(3)?,
        ))
      },
    )?;
    let (schema_version, state_revision, active_project_id, active_session_id) = global;
    let Some(state_revision) = state_revision else {
      return Ok(None);
    };
    let schema_version = schema_version.ok_or_else(|| {
      StorageError::WorkspaceCorruption(
        "The native project catalog has no project schema version.".into(),
      )
    })?;
    let active_project_id = active_project_id.ok_or_else(|| {
      StorageError::WorkspaceCorruption("The native project catalog has no active project.".into())
    })?;

    let mut statement = catalog.prepare(
      "SELECT project_id, storage_id
       FROM project_storage
       WHERE in_project_state = 1
       ORDER BY project_ordinal ASC",
    )?;
    let mappings = statement
      .query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
      })?
      .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    let mut projects = Vec::with_capacity(mappings.len());
    let mut session_documents: Vec<(u64, Value, Value)> = Vec::new();
    for (project_id, storage_id) in mappings {
      let connection = self.open_project_database(&storage_id)?;
      let project_json: Option<String> = connection.query_row(
        "SELECT project_json FROM project_state WHERE id = 1",
        [],
        |row| row.get(0),
      )?;
      let project_json = project_json.ok_or_else(|| {
        StorageError::WorkspaceCorruption(format!(
          "Project {project_id} is present in the catalog but has no project record."
        ))
      })?;
      let project: Value = serde_json::from_str(&project_json)?;
      if require_string(&project, "project_id").map_err(StorageError::WorkspaceCorruption)?
        != project_id
      {
        return Err(StorageError::WorkspaceCorruption(format!(
          "Project database identity does not match catalog project {project_id}."
        )));
      }
      projects.push(project);

      let mut session_statement = connection.prepare(
        "SELECT session_ordinal, session_json, document_json
         FROM session_state
         ORDER BY session_ordinal ASC",
      )?;
      let rows = session_statement.query_map([], |row| {
        Ok((
          row.get::<_, u64>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
        ))
      })?;
      for row in rows {
        let (ordinal, session_json, document_json) = row?;
        session_documents.push((
          ordinal,
          serde_json::from_str(&session_json)?,
          serde_json::from_str(&document_json)?,
        ));
      }
    }
    session_documents.sort_by_key(|(ordinal, _, _)| *ordinal);
    let (sessions, documents): (Vec<Value>, Vec<Value>) = session_documents
      .into_iter()
      .map(|(_, session, document)| (session, document))
      .unzip();

    Ok(Some(json!({
      "schema_version": schema_version,
      "state_revision": state_revision,
      "active_project_id": active_project_id,
      "active_session_id": active_session_id,
      "projects": projects,
      "sessions": sessions,
      "documents": documents,
    })))
  }

  pub(super) fn save_project_state(
    &self,
    state: &Value,
    expected_revision: Option<u64>,
  ) -> Result<(), StorageError> {
    self.with_project_state_lock(|| {
      self.recover_pending_project_save_locked()?;
      self.save_project_state_locked(state, expected_revision)
    })
  }

  fn save_project_state_locked(
    &self,
    state: &Value,
    expected_revision: Option<u64>,
  ) -> Result<(), StorageError> {
    let validated = validate_project_state(state)?;
    let expected_next_revision = expected_revision
      .unwrap_or(0)
      .checked_add(1)
      .filter(|revision| *revision <= MAX_SAFE_INTEGER)
      .ok_or_else(|| StorageError::InvalidRequest("Project store revision is exhausted.".into()))?;
    if validated.state_revision != expected_next_revision {
      return Err(StorageError::InvalidRequest(
        "Project store revisions must increase by exactly one.".into(),
      ));
    }
    let commit_id = Uuid::new_v4().simple().to_string();
    let journal_path = self.staging_journal_path(&commit_id)?;
    write_synced_file(&journal_path, json_string(state)?.as_bytes())?;
    let mut catalog = self.open_catalog()?;
    let transaction = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current_revision: Option<u64> = transaction.query_row(
      "SELECT state_revision FROM catalog_state WHERE id = 1",
      [],
      |row| row.get(0),
    )?;
    if current_revision != expected_revision {
      let _ = fs::remove_file(journal_path);
      return Err(StorageError::ProjectStoreConflict);
    }

    let mut mappings = Map::new();
    for project in validated.projects {
      let project_id =
        require_string(project, "project_id").map_err(StorageError::InvalidRequest)?;
      let storage_id: Option<String> = transaction
        .query_row(
          "SELECT storage_id FROM project_storage WHERE project_id = ?1",
          [project_id],
          |row| row.get(0),
        )
        .optional()?;
      mappings.insert(
        project_id.to_owned(),
        Value::String(storage_id.unwrap_or_else(|| Uuid::new_v4().simple().to_string())),
      );
    }
    transaction.execute(
      "INSERT OR REPLACE INTO pending_project_commit (
        id, commit_id, mappings_json
      ) VALUES (1, ?1, ?2)",
      params![commit_id, json_string(&Value::Object(mappings))?],
    )?;
    transaction.commit()?;
    self.recover_pending_project_save_locked()
  }

  pub(super) fn recover_pending_project_save_locked(&self) -> Result<(), StorageError> {
    let catalog = self.open_catalog()?;
    let pending: Option<(String, String)> = catalog
      .query_row(
        "SELECT commit_id, mappings_json FROM pending_project_commit WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
      )
      .optional()?;
    let Some((commit_id, mappings_json)) = pending else {
      return Ok(());
    };
    let journal_path = self.staging_journal_path(&commit_id)?;
    let state_json = fs::read_to_string(&journal_path).map_err(|error| {
      StorageError::WorkspaceCorruption(format!(
        "Pending project save {commit_id} has no readable staging journal: {error}"
      ))
    })?;
    let state: Value = serde_json::from_str(&state_json)?;
    let mappings: Value = serde_json::from_str(&mappings_json)?;
    self.apply_pending_project_save(&state, &mappings)?;
    let _ = fs::remove_file(journal_path);
    Ok(())
  }

  fn apply_pending_project_save(
    &self,
    state: &Value,
    mappings: &Value,
  ) -> Result<(), StorageError> {
    let validated = validate_project_state(state)?;
    let mappings = mappings.as_object().ok_or_else(|| {
      StorageError::WorkspaceCorruption(
        "Pending project save contains invalid storage mappings.".into(),
      )
    })?;
    let documents = validated
      .documents
      .iter()
      .map(|document| {
        let session_id =
          require_string(document, "session_id").map_err(StorageError::WorkspaceCorruption)?;
        Ok((session_id.to_owned(), document))
      })
      .collect::<Result<HashMap<_, _>, StorageError>>()?;

    let mut mapped_storage_ids = HashSet::new();
    for project in validated.projects {
      let project_id =
        require_string(project, "project_id").map_err(StorageError::WorkspaceCorruption)?;
      let storage_id = mappings
        .get(project_id)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
          StorageError::WorkspaceCorruption(format!(
            "Pending project save has no storage mapping for {project_id}."
          ))
        })?;
      super::database::validate_opaque_id(storage_id, "pending storage_id")?;
      if !mapped_storage_ids.insert(storage_id) {
        return Err(StorageError::WorkspaceCorruption(
          "Pending project save maps more than one project to the same storage identifier.".into(),
        ));
      }
      let existing_storage_id = self.storage_id_for_project(project_id)?;
      let mut connection = match existing_storage_id {
        Some(existing_storage_id) => {
          if existing_storage_id != storage_id {
            return Err(StorageError::WorkspaceCorruption(format!(
              "Pending project save changes the storage mapping for {project_id}."
            )));
          }
          self.open_project_database(storage_id)?
        }
        None => self.open_or_create_unpublished_project_database(storage_id)?,
      };
      let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
      transaction.execute(
        "UPDATE project_state SET project_json = ?1 WHERE id = 1",
        [json_string(project)?],
      )?;
      transaction.execute("DELETE FROM session_state", [])?;
      for (session_ordinal, session) in validated.sessions.iter().enumerate() {
        if require_string(session, "project_id").map_err(StorageError::WorkspaceCorruption)?
          != project_id
        {
          continue;
        }
        let session_id =
          require_string(session, "session_id").map_err(StorageError::WorkspaceCorruption)?;
        let document = documents.get(session_id).ok_or_else(|| {
          StorageError::WorkspaceCorruption(format!("Session {session_id} has no document."))
        })?;
        transaction.execute(
          "INSERT INTO session_state (
            session_id, session_ordinal, session_json, document_json
          ) VALUES (?1, ?2, ?3, ?4)",
          params![
            session_id,
            session_ordinal as u64,
            json_string(session)?,
            json_string(document)?,
          ],
        )?;
      }
      transaction.commit()?;
    }

    let mut catalog = self.open_catalog()?;
    let transaction = catalog.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let pending_exists: bool = transaction.query_row(
      "SELECT EXISTS(SELECT 1 FROM pending_project_commit WHERE id = 1)",
      [],
      |row| row.get(0),
    )?;
    if !pending_exists {
      return Ok(());
    }
    transaction.execute(
      "UPDATE project_storage
       SET in_project_state = 0, project_ordinal = NULL",
      [],
    )?;
    for (ordinal, project) in validated.projects.iter().enumerate() {
      let project_id =
        require_string(project, "project_id").map_err(StorageError::WorkspaceCorruption)?;
      let storage_id = mappings
        .get(project_id)
        .and_then(Value::as_str)
        .ok_or_else(|| {
          StorageError::WorkspaceCorruption(format!(
            "Pending project save has no storage mapping for {project_id}."
          ))
        })?;
      transaction.execute(
        "INSERT INTO project_storage (
          project_id, storage_id, project_ordinal, in_project_state
        ) VALUES (?1, ?2, ?3, 1)
        ON CONFLICT(project_id) DO UPDATE SET
          storage_id = excluded.storage_id,
          project_ordinal = excluded.project_ordinal,
          in_project_state = 1",
        params![project_id, storage_id, ordinal as u64],
      )?;
    }
    transaction.execute(
      "UPDATE catalog_state SET
        project_schema_version = ?1,
        state_revision = ?2,
        active_project_id = ?3,
        active_session_id = ?4
       WHERE id = 1",
      params![
        validated.schema_version,
        validated.state_revision,
        validated.active_project_id,
        validated.active_session_id,
      ],
    )?;
    transaction.execute("DELETE FROM pending_project_commit WHERE id = 1", [])?;
    transaction.commit()?;
    Ok(())
  }
}

fn write_synced_file(path: &std::path::Path, contents: &[u8]) -> Result<(), StorageError> {
  let mut file = File::create(path)?;
  file.write_all(contents)?;
  file.sync_all()?;
  #[cfg(unix)]
  if let Some(parent) = path.parent() {
    File::open(parent)?.sync_all()?;
  }
  Ok(())
}
