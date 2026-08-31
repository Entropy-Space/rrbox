use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use uuid::Uuid;

use crate::protocol::{DshSessionRevision, DshStoredSession, DshStoredSessionSuffix};

use super::{StorageError, StorageService, database::validate_opaque_id};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

struct StoredHeader {
  header: Value,
  storage_id: String,
  revision: u64,
  event_count: u64,
}

impl StorageService {
  pub(super) fn dsh_session_load(
    &self,
    project_id: &str,
    session_id: &str,
  ) -> Result<Option<DshStoredSession>, StorageError> {
    validate_identity(project_id, "project_id")?;
    validate_identity(session_id, "session_id")?;
    let connection = self.project_connection(project_id)?;
    let Some(stored) = read_header(&connection, session_id)? else {
      ensure_no_orphan_events(&connection, session_id)?;
      return Ok(None);
    };
    let events = read_events(&connection, session_id, 0, stored.event_count)?;
    Ok(Some(DshStoredSession {
      header: stored.header,
      events,
      storage_id: stored.storage_id,
      revision: stored.revision,
    }))
  }

  pub(super) fn dsh_session_load_from(
    &self,
    project_id: &str,
    session_id: &str,
    from_seq: u64,
  ) -> Result<Option<DshStoredSessionSuffix>, StorageError> {
    validate_identity(project_id, "project_id")?;
    validate_identity(session_id, "session_id")?;
    validate_safe_integer(from_seq, "from_seq")?;
    let connection = self.project_connection(project_id)?;
    let Some(stored) = read_header(&connection, session_id)? else {
      ensure_no_orphan_events(&connection, session_id)?;
      return Ok(None);
    };
    let effective_from = from_seq.min(stored.event_count);
    let events = read_events(
      &connection,
      session_id,
      effective_from,
      stored.event_count - effective_from,
    )?;
    Ok(Some(DshStoredSessionSuffix {
      header: stored.header,
      events,
    }))
  }

  pub(super) fn dsh_session_read_revision(
    &self,
    project_id: &str,
    session_id: &str,
  ) -> Result<Option<DshSessionRevision>, StorageError> {
    validate_identity(project_id, "project_id")?;
    validate_identity(session_id, "session_id")?;
    let connection = self.project_connection(project_id)?;
    let stored = read_header(&connection, session_id)?;
    if stored.is_none() {
      ensure_no_orphan_events(&connection, session_id)?;
    }
    Ok(stored.map(|stored| DshSessionRevision {
      storage_id: stored.storage_id,
      revision: stored.revision,
    }))
  }

  pub(super) fn dsh_session_append(
    &self,
    project_id: &str,
    header: &Value,
    events: &[Value],
    is_materialized: bool,
  ) -> Result<(), StorageError> {
    validate_identity(project_id, "project_id")?;
    if events.is_empty() {
      return Ok(());
    }
    let session_id = validate_header(header)?;
    let mut connection = self.project_connection(project_id)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = read_header(&transaction, session_id)?;
    if is_materialized != existing.is_some() {
      return Err(corruption(session_id, "materialization state changed"));
    }
    if let Some(stored) = &existing {
      if stored.header != *header {
        return Err(corruption(session_id, "header changed"));
      }
    } else {
      require_dsh_host_document(&transaction, session_id)?;
    }

    let expected_seq = existing.as_ref().map_or(0, |stored| stored.event_count);
    validate_event_batch(events, expected_seq)?;
    let next_revision = existing
      .as_ref()
      .map_or(Some(1), |stored| stored.revision.checked_add(1))
      .ok_or_else(|| corruption(session_id, "revision overflowed"))?;
    let next_event_count = expected_seq
      .checked_add(events.len() as u64)
      .ok_or_else(|| corruption(session_id, "event count overflowed"))?;
    validate_safe_integer(next_revision, "DSH session revision")?;
    validate_safe_integer(next_event_count, "DSH session event count")?;
    let storage_id = existing
      .as_ref()
      .map(|stored| stored.storage_id.clone())
      .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
    let header_json = serde_json::to_string(header)?;

    transaction.execute(
      "INSERT INTO dsh_session_headers (
        session_id, header_json, storage_id, revision, event_count
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(session_id) DO UPDATE SET
        header_json = excluded.header_json,
        storage_id = excluded.storage_id,
        revision = excluded.revision,
        event_count = excluded.event_count",
      params![
        session_id,
        header_json,
        storage_id,
        to_sqlite_integer(next_revision, "DSH session revision")?,
        to_sqlite_integer(next_event_count, "DSH session event count")?,
      ],
    )?;
    for event in events {
      let seq = require_u64(event, "seq", "DSH session event")?;
      transaction.execute(
        "INSERT INTO dsh_session_events (session_id, seq, event_json)
         VALUES (?1, ?2, ?3)",
        params![
          session_id,
          to_sqlite_integer(seq, "DSH event seq")?,
          serde_json::to_string(event)?,
        ],
      )?;
    }
    transaction.commit()?;
    Ok(())
  }

  pub(super) fn dsh_session_list(&self, project_id: &str) -> Result<Vec<Value>, StorageError> {
    validate_identity(project_id, "project_id")?;
    let connection = self.project_connection(project_id)?;
    let mut statement = connection.prepare(
      "SELECT session_id, header_json, storage_id, revision, event_count
       FROM dsh_session_headers ORDER BY session_id COLLATE BINARY",
    )?;
    let rows = statement
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, i64>(3)?,
          row.get::<_, i64>(4)?,
        ))
      })?
      .collect::<Result<Vec<_>, _>>()?;
    rows
      .into_iter()
      .map(
        |(session_id, header_json, storage_id, revision, event_count)| {
          let stored =
            parse_header_row(&session_id, &header_json, storage_id, revision, event_count)?;
          Ok(stored.header)
        },
      )
      .collect()
  }

  pub(super) fn dsh_session_delete(
    &self,
    project_id: &str,
    session_id: &str,
  ) -> Result<(), StorageError> {
    validate_identity(project_id, "project_id")?;
    validate_identity(session_id, "session_id")?;
    let connection = self.project_connection(project_id)?;
    connection.execute(
      "DELETE FROM dsh_session_headers WHERE session_id = ?1",
      [session_id],
    )?;
    Ok(())
  }
}

fn read_header(
  connection: &Connection,
  session_id: &str,
) -> Result<Option<StoredHeader>, StorageError> {
  let row = connection
    .query_row(
      "SELECT header_json, storage_id, revision, event_count
       FROM dsh_session_headers WHERE session_id = ?1",
      [session_id],
      |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, i64>(2)?,
          row.get::<_, i64>(3)?,
        ))
      },
    )
    .optional()?;
  row
    .map(|(header_json, storage_id, revision, event_count)| {
      parse_header_row(session_id, &header_json, storage_id, revision, event_count)
    })
    .transpose()
}

fn parse_header_row(
  session_id: &str,
  header_json: &str,
  storage_id: String,
  revision: i64,
  event_count: i64,
) -> Result<StoredHeader, StorageError> {
  validate_opaque_id(&storage_id, "DSH session storage_id")?;
  let revision = from_sqlite_integer(revision, "DSH session revision")?;
  let event_count = from_sqlite_integer(event_count, "DSH session event count")?;
  if revision == 0 || event_count == 0 {
    return Err(corruption(session_id, "has invalid header metadata"));
  }
  let header: Value = serde_json::from_str(header_json)
    .map_err(|_| corruption(session_id, "has invalid header JSON"))?;
  let header_session_id =
    validate_header(&header).map_err(|_| corruption(session_id, "has invalid header metadata"))?;
  if header_session_id != session_id {
    return Err(corruption(session_id, "has a mismatched header id"));
  }
  Ok(StoredHeader {
    header,
    storage_id,
    revision,
    event_count,
  })
}

fn read_events(
  connection: &Connection,
  session_id: &str,
  from_seq: u64,
  expected_count: u64,
) -> Result<Vec<Value>, StorageError> {
  let mut statement = connection.prepare(
    "SELECT seq, event_json FROM dsh_session_events
     WHERE session_id = ?1 AND seq >= ?2 ORDER BY seq",
  )?;
  let rows = statement
    .query_map(
      params![
        session_id,
        to_sqlite_integer(from_seq, "DSH event suffix seq")?,
      ],
      |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
    )?
    .collect::<Result<Vec<_>, _>>()?;
  if rows.len() as u64 != expected_count {
    return Err(corruption(session_id, "has an incomplete event region"));
  }
  rows
    .into_iter()
    .enumerate()
    .map(|(index, (stored_seq, event_json))| {
      let expected_seq = from_seq + index as u64;
      let stored_seq = from_sqlite_integer(stored_seq, "stored DSH event seq")?;
      let event: Value = serde_json::from_str(&event_json)
        .map_err(|_| corruption(session_id, "has invalid event JSON"))?;
      validate_event(&event, expected_seq).map_err(|_| {
        corruption(
          session_id,
          &format!("has an invalid event at seq {expected_seq}"),
        )
      })?;
      if stored_seq != expected_seq {
        return Err(corruption(
          session_id,
          &format!("has an invalid event row at seq {expected_seq}"),
        ));
      }
      Ok(event)
    })
    .collect()
}

fn require_dsh_host_document(
  connection: &Connection,
  session_id: &str,
) -> Result<(), StorageError> {
  let document_json: Option<String> = connection
    .query_row(
      "SELECT document_json FROM session_state WHERE session_id = ?1",
      [session_id],
      |row| row.get(0),
    )
    .optional()?;
  let Some(document_json) = document_json else {
    return Err(StorageError::InvalidRequest(format!(
      "DSH session {session_id} has no native host document."
    )));
  };
  let document: Value = serde_json::from_str(&document_json)
    .map_err(|_| corruption(session_id, "has an invalid native host document"))?;
  if document.get("session_id").and_then(Value::as_str) != Some(session_id)
    || document.get("runtime_id").and_then(Value::as_str) != Some("dsh")
  {
    return Err(corruption(
      session_id,
      "is not owned by a DSH native host document",
    ));
  }
  Ok(())
}

fn ensure_no_orphan_events(connection: &Connection, session_id: &str) -> Result<(), StorageError> {
  let count: u64 = connection.query_row(
    "SELECT COUNT(*) FROM dsh_session_events WHERE session_id = ?1",
    [session_id],
    |row| row.get(0),
  )?;
  if count > 0 {
    return Err(corruption(session_id, "has events without a header"));
  }
  Ok(())
}

fn validate_header(header: &Value) -> Result<&str, StorageError> {
  let session_id = header
    .get("id")
    .and_then(Value::as_str)
    .filter(|value| !value.is_empty())
    .ok_or_else(|| {
      StorageError::InvalidRequest("DSH header id must be a non-empty string.".into())
    })?;
  require_u64(header, "version", "DSH session header")?;
  require_u64(header, "createdAt", "DSH session header")?;
  Ok(session_id)
}

fn validate_event_batch(events: &[Value], expected_seq: u64) -> Result<(), StorageError> {
  for (index, event) in events.iter().enumerate() {
    validate_event(event, expected_seq + index as u64)?;
  }
  Ok(())
}

fn validate_event(event: &Value, expected_seq: u64) -> Result<(), StorageError> {
  let seq = require_u64(event, "seq", "DSH session event")?;
  if seq != expected_seq {
    return Err(StorageError::InvalidRequest(format!(
      "DSH event seq {seq} does not match stored seq {expected_seq}."
    )));
  }
  event
    .get("type")
    .and_then(Value::as_str)
    .filter(|value| !value.is_empty())
    .ok_or_else(|| {
      StorageError::InvalidRequest("DSH event type must be a non-empty string.".into())
    })?;
  require_u64(event, "time", "DSH session event")?;
  if event.get("data").is_none() {
    return Err(StorageError::InvalidRequest(
      "DSH session event data is required.".into(),
    ));
  }
  Ok(())
}

fn require_u64(value: &Value, field: &str, label: &str) -> Result<u64, StorageError> {
  let value = value.get(field).and_then(Value::as_u64).ok_or_else(|| {
    StorageError::InvalidRequest(format!("{label} {field} must be a non-negative integer."))
  })?;
  validate_safe_integer(value, &format!("{label} {field}"))?;
  Ok(value)
}

fn validate_identity(value: &str, field: &str) -> Result<(), StorageError> {
  if value.is_empty() {
    return Err(StorageError::InvalidRequest(format!(
      "{field} must be a non-empty string."
    )));
  }
  Ok(())
}

fn validate_safe_integer(value: u64, field: &str) -> Result<(), StorageError> {
  if value > MAX_SAFE_INTEGER {
    return Err(StorageError::InvalidRequest(format!(
      "{field} must be a JavaScript-safe integer."
    )));
  }
  Ok(())
}

fn to_sqlite_integer(value: u64, field: &str) -> Result<i64, StorageError> {
  validate_safe_integer(value, field)?;
  i64::try_from(value)
    .map_err(|_| StorageError::InvalidRequest(format!("{field} is too large for native storage.")))
}

fn from_sqlite_integer(value: i64, field: &str) -> Result<u64, StorageError> {
  let value = u64::try_from(value)
    .map_err(|_| StorageError::WorkspaceCorruption(format!("{field} is negative.")))?;
  if value > MAX_SAFE_INTEGER {
    return Err(StorageError::WorkspaceCorruption(format!(
      "{field} exceeds the JavaScript safe-integer range."
    )));
  }
  Ok(value)
}

fn corruption(session_id: &str, detail: &str) -> StorageError {
  StorageError::WorkspaceCorruption(format!("Stored DSH session {session_id} {detail}."))
}
