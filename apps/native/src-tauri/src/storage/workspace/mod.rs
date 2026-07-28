mod history;
mod lifecycle;
mod mutation;
mod query;
mod receipts;
mod repository;

use serde_json::Value;

#[cfg(test)]
use crate::protocol::VfsSeedFile;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
struct WorkspaceMeta {
  active: bool,
  incarnation_id: Option<String>,
  workspace_revision: u64,
  last_change_at: Option<String>,
}

#[derive(Debug, Clone)]
struct StoredFile {
  path: String,
  content: String,
  path_revision: u64,
}

enum InitialFileSource<'a> {
  #[cfg(test)]
  Typed(&'a [VfsSeedFile]),
  Wire(&'a [Value]),
}
