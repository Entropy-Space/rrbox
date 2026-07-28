use std::collections::BTreeMap;

use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::protocol::WorkspaceHandle;

use super::{
  super::{StorageError, StorageService},
  repository::{
    assert_workspace_handle, has_descendants, normalize_file_path, normalize_path, read_all_files,
    read_file,
  },
};

impl StorageService {
  pub(in crate::storage) fn workspace_list(
    &self,
    workspace: &WorkspaceHandle,
    path: &str,
  ) -> Result<Value, StorageError> {
    let normalized_path = normalize_path(path)?;
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction()?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    if read_file(&transaction, &normalized_path)?.is_some() {
      return Err(StorageError::vfs(
        "vfs_not_directory",
        format!("Expected a directory but found a file: {normalized_path}"),
      ));
    }
    let directory = if normalized_path == "/" {
      "/".to_owned()
    } else {
      format!("{normalized_path}/")
    };
    let files = read_all_files(&transaction)?;
    let mut entries: BTreeMap<String, Value> = BTreeMap::new();
    for file in files {
      let Some(remainder) = file.path.strip_prefix(&directory) else {
        continue;
      };
      if remainder.is_empty() {
        continue;
      }
      let mut parts = remainder.split('/');
      let Some(name) = parts.next() else {
        continue;
      };
      let is_directory = parts.next().is_some();
      let entry_path = if directory == "/" {
        format!("/{name}")
      } else {
        format!("{directory}{name}")
      };
      let candidate = if is_directory {
        json!({
          "name": name,
          "path": entry_path,
          "kind": "directory",
          "size": 0,
        })
      } else {
        json!({
          "name": name,
          "path": entry_path,
          "kind": "file",
          "size": file.content.len(),
        })
      };
      entries
        .entry(name.to_owned())
        .and_modify(|current| {
          if current.get("kind").and_then(Value::as_str) == Some("file") && is_directory {
            *current = candidate.clone();
          }
        })
        .or_insert(candidate);
    }
    let mut entries = entries.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
      let left_kind = left.get("kind").and_then(Value::as_str).unwrap_or("");
      let right_kind = right.get("kind").and_then(Value::as_str).unwrap_or("");
      let kind_order = match (left_kind, right_kind) {
        ("directory", "file") => std::cmp::Ordering::Less,
        ("file", "directory") => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
      };
      kind_order.then_with(|| {
        left
          .get("name")
          .and_then(Value::as_str)
          .cmp(&right.get("name").and_then(Value::as_str))
      })
    });
    transaction.commit()?;
    Ok(json!({
      "workspace_revision": meta.workspace_revision,
      "entries": entries,
    }))
  }

  pub(in crate::storage) fn workspace_read(
    &self,
    workspace: &WorkspaceHandle,
    path: &str,
  ) -> Result<Value, StorageError> {
    let normalized_path = normalize_file_path(path)?;
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction()?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    let file = read_file(&transaction, &normalized_path)?;
    if let Some(file) = file {
      transaction.commit()?;
      return Ok(json!({
        "workspace_revision": meta.workspace_revision,
        "path_revision": file.path_revision,
        "content": file.content,
      }));
    }
    if has_descendants(&transaction, &normalized_path)? {
      return Err(StorageError::vfs(
        "vfs_is_directory",
        format!("Path is a directory: {normalized_path}"),
      ));
    }
    Err(StorageError::vfs(
      "vfs_not_found",
      format!("File not found: {normalized_path}"),
    ))
  }

  pub(in crate::storage) fn workspace_get_path_state(
    &self,
    workspace: &WorkspaceHandle,
    path: &str,
  ) -> Result<Value, StorageError> {
    let normalized_path = normalize_path(path)?;
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction()?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    let value = if let Some(file) = read_file(&transaction, &normalized_path)? {
      json!({
        "workspace_revision": meta.workspace_revision,
        "path": normalized_path,
        "kind": "file",
        "path_revision": file.path_revision,
        "content": file.content,
      })
    } else if normalized_path == "/" || has_descendants(&transaction, &normalized_path)? {
      json!({
        "workspace_revision": meta.workspace_revision,
        "path": normalized_path,
        "kind": "directory",
        "path_revision": null,
      })
    } else {
      let path_revision: Option<u64> = transaction
        .query_row(
          "SELECT path_revision FROM workspace_path_revisions WHERE path = ?1",
          [&normalized_path],
          |row| row.get(0),
        )
        .optional()?;
      json!({
        "workspace_revision": meta.workspace_revision,
        "path": normalized_path,
        "kind": "missing",
        "path_revision": path_revision,
      })
    };
    transaction.commit()?;
    Ok(value)
  }

  pub(in crate::storage) fn workspace_read_files_snapshot(
    &self,
    workspace: &WorkspaceHandle,
  ) -> Result<Value, StorageError> {
    let mut connection = self.project_connection(&workspace.project_id)?;
    let transaction = connection.transaction()?;
    let meta = assert_workspace_handle(&transaction, workspace)?;
    let files = read_all_files(&transaction)?
      .into_iter()
      .map(|file| json!({ "path": file.path, "content": file.content }))
      .collect::<Vec<_>>();
    transaction.commit()?;
    Ok(json!({
      "workspace_revision": meta.workspace_revision,
      "files": files,
    }))
  }
}
