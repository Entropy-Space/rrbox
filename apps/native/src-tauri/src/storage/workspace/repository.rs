use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, Transaction};
use serde_json::Value;

use crate::protocol::{VfsSeedFile, WorkspaceHandle};

use super::{super::StorageError, MAX_SAFE_INTEGER, StoredFile, WorkspaceMeta};

pub(super) fn read_workspace_meta(
  transaction: &Transaction<'_>,
) -> Result<WorkspaceMeta, StorageError> {
  transaction
    .query_row(
      "SELECT active, incarnation_id, workspace_revision, last_change_at
       FROM workspace_meta WHERE id = 1",
      [],
      |row| {
        Ok(WorkspaceMeta {
          active: row.get(0)?,
          incarnation_id: row.get(1)?,
          workspace_revision: row.get(2)?,
          last_change_at: row.get(3)?,
        })
      },
    )
    .map_err(Into::into)
}

pub(super) fn read_workspace_meta_connection(
  connection: &Connection,
) -> Result<WorkspaceMeta, StorageError> {
  connection
    .query_row(
      "SELECT active, incarnation_id, workspace_revision, last_change_at
       FROM workspace_meta WHERE id = 1",
      [],
      |row| {
        Ok(WorkspaceMeta {
          active: row.get(0)?,
          incarnation_id: row.get(1)?,
          workspace_revision: row.get(2)?,
          last_change_at: row.get(3)?,
        })
      },
    )
    .map_err(Into::into)
}

pub(super) fn assert_workspace_handle(
  transaction: &Transaction<'_>,
  workspace: &WorkspaceHandle,
) -> Result<WorkspaceMeta, StorageError> {
  validate_identifier(&workspace.project_id, "workspace.project_id")?;
  validate_identifier(&workspace.incarnation_id, "workspace.incarnation_id")?;
  let meta = read_workspace_meta(transaction)?;
  if !meta.active {
    return Err(StorageError::vfs(
      "vfs_not_found",
      format!(
        "Project workspace no longer exists: {}",
        workspace.project_id
      ),
    ));
  }
  if meta.incarnation_id.as_deref() != Some(workspace.incarnation_id.as_str()) {
    return Err(StorageError::vfs(
      "vfs_conflict",
      format!(
        "Workspace handle belongs to an older incarnation: {}",
        workspace.project_id
      ),
    ));
  }
  Ok(meta)
}

pub(super) fn read_file(
  transaction: &Transaction<'_>,
  path: &str,
) -> Result<Option<StoredFile>, StorageError> {
  transaction
    .query_row(
      "SELECT path, content, path_revision
       FROM workspace_files WHERE path = ?1",
      [path],
      |row| {
        Ok(StoredFile {
          path: row.get(0)?,
          content: row.get(1)?,
          path_revision: row.get(2)?,
        })
      },
    )
    .optional()
    .map_err(Into::into)
}

pub(super) fn read_all_files(
  transaction: &Transaction<'_>,
) -> Result<Vec<StoredFile>, StorageError> {
  let mut statement = transaction
    .prepare("SELECT path, content, path_revision FROM workspace_files ORDER BY path ASC")?;
  statement
    .query_map([], |row| {
      Ok(StoredFile {
        path: row.get(0)?,
        content: row.get(1)?,
        path_revision: row.get(2)?,
      })
    })?
    .collect::<Result<Vec<_>, _>>()
    .map_err(Into::into)
}

pub(super) fn normalize_path(path: &str) -> Result<String, StorageError> {
  let normalized_input = path.replace('\\', "/");
  let mut segments = Vec::new();
  for segment in normalized_input.split('/') {
    if segment.is_empty() || segment == "." {
      continue;
    }
    if segment == ".." {
      if segments.pop().is_none() {
        return Err(StorageError::vfs(
          "vfs_invalid_path",
          "Path escapes the workspace.",
        ));
      }
      continue;
    }
    if segment.contains('\0') {
      return Err(StorageError::vfs(
        "vfs_invalid_path",
        "Path contains a null byte.",
      ));
    }
    segments.push(segment);
  }
  Ok(format!("/{}", segments.join("/")))
}

pub(super) fn normalize_file_path(path: &str) -> Result<String, StorageError> {
  let path = normalize_path(path)?;
  if path == "/" {
    return Err(StorageError::vfs(
      "vfs_invalid_path",
      "Expected a file path.",
    ));
  }
  Ok(path)
}

pub(super) fn normalize_initial_files(
  files: &[VfsSeedFile],
) -> Result<Vec<VfsSeedFile>, StorageError> {
  let mut normalized = HashMap::new();
  let mut directories = HashSet::new();
  for file in files {
    let path = normalize_file_path(&file.path)?;
    if normalized.contains_key(&path) {
      return Err(StorageError::vfs(
        "vfs_conflict",
        format!("Initial file resolves to a duplicate path: {path}"),
      ));
    }
    if directories.contains(&path) {
      return Err(StorageError::vfs(
        "vfs_is_directory",
        format!("Cannot replace an initial directory with a file: {path}"),
      ));
    }
    for ancestor in ancestors(&path) {
      if normalized.contains_key(&ancestor) {
        return Err(StorageError::vfs(
          "vfs_not_directory",
          format!("Cannot create an initial file beneath another file: {ancestor}"),
        ));
      }
      directories.insert(ancestor);
    }
    normalized.insert(path, file.content.clone());
  }
  Ok(
    normalized
      .into_iter()
      .map(|(path, content)| VfsSeedFile { path, content })
      .collect(),
  )
}

pub(super) fn normalize_wire_initial_files(
  files: &[Value],
) -> Result<Vec<VfsSeedFile>, StorageError> {
  let decoded = files
    .iter()
    .map(|file| {
      let record = file.as_object().ok_or_else(|| {
        StorageError::vfs(
          "vfs_invalid_path",
          "Initial files must contain string paths and content.",
        )
      })?;
      if record
        .keys()
        .any(|field| !matches!(field.as_str(), "path" | "content"))
      {
        return Err(StorageError::vfs(
          "vfs_invalid_path",
          "Initial files contain an unexpected field.",
        ));
      }
      let path = record.get("path").and_then(Value::as_str);
      let content = record.get("content").and_then(Value::as_str);
      match (path, content) {
        (Some(path), Some(content)) => Ok(VfsSeedFile {
          path: path.to_owned(),
          content: content.to_owned(),
        }),
        _ => Err(StorageError::vfs(
          "vfs_invalid_path",
          "Initial files must contain string paths and content.",
        )),
      }
    })
    .collect::<Result<Vec<_>, _>>()?;
  normalize_initial_files(&decoded)
}

pub(super) fn assert_writable_path(
  transaction: &Transaction<'_>,
  path: &str,
) -> Result<(), StorageError> {
  if has_descendants(transaction, path)? {
    return Err(StorageError::vfs(
      "vfs_is_directory",
      format!("Cannot replace a directory with a file: {path}"),
    ));
  }
  for ancestor in ancestors(path) {
    if read_file(transaction, &ancestor)?.is_some() {
      return Err(StorageError::vfs(
        "vfs_not_directory",
        format!("Cannot create a file beneath another file: {ancestor}"),
      ));
    }
  }
  Ok(())
}

pub(super) fn has_descendants(
  transaction: &Transaction<'_>,
  path: &str,
) -> Result<bool, StorageError> {
  let prefix = format!("{path}/");
  transaction
    .query_row(
      "SELECT EXISTS(
        SELECT 1 FROM workspace_files WHERE instr(path, ?1) = 1
      )",
      [prefix],
      |row| row.get(0),
    )
    .map_err(Into::into)
}

pub(super) fn has_file_ancestor(
  transaction: &Transaction<'_>,
  path: &str,
) -> Result<bool, StorageError> {
  for ancestor in ancestors(path) {
    if read_file(transaction, &ancestor)?.is_some() {
      return Ok(true);
    }
  }
  Ok(false)
}

fn ancestors(path: &str) -> Vec<String> {
  let segments = path
    .split('/')
    .filter(|segment| !segment.is_empty())
    .collect::<Vec<_>>();
  (1..segments.len())
    .map(|index| format!("/{}", segments[..index].join("/")))
    .collect()
}

pub(super) fn invalidate_related_missing_revisions(
  transaction: &Transaction<'_>,
  path: &str,
) -> Result<(), StorageError> {
  for ancestor in ancestors(path) {
    if read_file(transaction, &ancestor)?.is_none() {
      transaction.execute(
        "DELETE FROM workspace_path_revisions WHERE path = ?1",
        [ancestor],
      )?;
    }
  }
  let prefix = format!("{path}/");
  let mut statement =
    transaction.prepare("SELECT path FROM workspace_path_revisions WHERE instr(path, ?1) = 1")?;
  let candidates = statement
    .query_map([prefix], |row| row.get::<_, String>(0))?
    .collect::<Result<Vec<_>, _>>()?;
  drop(statement);
  for candidate in candidates {
    if read_file(transaction, &candidate)?.is_none() {
      transaction.execute(
        "DELETE FROM workspace_path_revisions WHERE path = ?1",
        [candidate],
      )?;
    }
  }
  Ok(())
}

pub(super) fn next_revision(revision: u64) -> Result<u64, StorageError> {
  if revision >= MAX_SAFE_INTEGER {
    return Err(StorageError::vfs(
      "vfs_conflict",
      "Workspace revision is exhausted.",
    ));
  }
  Ok(revision + 1)
}

pub(super) fn validate_identifier(value: &str, field: &str) -> Result<(), StorageError> {
  if value.is_empty() {
    return Err(StorageError::InvalidRequest(format!(
      "{field} must be a non-empty string."
    )));
  }
  Ok(())
}
