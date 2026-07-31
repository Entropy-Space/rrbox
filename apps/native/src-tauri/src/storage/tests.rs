use std::sync::{Arc, Barrier};

use serde_json::{Value, json};
use tempfile::TempDir;

use crate::protocol::{
  ExpectedContent, WorkspaceChangeMetadata, WorkspaceRemoveOptions, WorkspaceToolName,
  WorkspaceWriteOptions,
};

use super::{StorageError, StorageService};

fn service() -> (TempDir, StorageService) {
  let directory = tempfile::tempdir().expect("temporary storage directory");
  let service = initialized_service(directory.path().join("researchbox"));
  (directory, service)
}

fn initialized_service(root: std::path::PathBuf) -> StorageService {
  let service = StorageService::new(root).expect("storage service");
  service.initialize().expect("initialize storage service");
  service
}

fn project(project_id: &str, name: &str, last_session_id: Option<&str>) -> Value {
  json!({
    "project_id": project_id,
    "name": name,
    "created_at": "2026-07-28T00:00:00.000Z",
    "updated_at": "2026-07-28T00:00:00.000Z",
    "last_session_id": last_session_id,
    "new_chat_draft": "",
    "new_chat_model": {
      "provider_id": "researchbox",
      "model_id": "researchbox-mock",
    },
    "new_chat_reasoning_effort": "default",
  })
}

fn session(session_id: &str, project_id: &str) -> Value {
  json!({
    "session_id": session_id,
    "project_id": project_id,
    "title": session_id,
    "title_is_custom": false,
    "created_at": "2026-07-28T00:00:00.000Z",
    "updated_at": "2026-07-28T00:00:00.000Z",
    "selected_model": {
      "provider_id": "researchbox",
      "model_id": "researchbox-mock",
    },
    "reasoning_effort": "default",
  })
}

fn document(session_id: &str, project_id: &str) -> Value {
  json!({
    "format_version": 4,
    "session_id": session_id,
    "project_id": project_id,
    "input_draft": "",
    "timeline": [],
  })
}

fn state(
  revision: u64,
  active_project_id: &str,
  projects: Vec<Value>,
  sessions: Vec<Value>,
  documents: Vec<Value>,
) -> Value {
  json!({
    "schema_version": 4,
    "state_revision": revision,
    "active_project_id": active_project_id,
    "active_session_id": null,
    "projects": projects,
    "sessions": sessions,
    "documents": documents,
  })
}

fn change(
  change_id: &str,
  tool_name: WorkspaceToolName,
  created_at: &str,
) -> WorkspaceChangeMetadata {
  WorkspaceChangeMetadata {
    change_id: change_id.into(),
    session_id: "session-1".into(),
    tool_call_block_id: format!("block-{change_id}"),
    assistant_message_index: 0,
    tool_call_id: format!("call-{change_id}"),
    tool_name,
    created_at: created_at.into(),
  }
}

fn revision(value: &Value) -> u64 {
  value["workspace_revision"]
    .as_u64()
    .expect("workspace revision")
}

fn storage_id(storage: &StorageService, project_id: &str) -> String {
  storage
    .open_catalog()
    .expect("catalog")
    .query_row(
      "SELECT storage_id FROM project_storage WHERE project_id = ?1",
      [project_id],
      |row| row.get(0),
    )
    .expect("project storage id")
}

#[test]
fn project_state_reopens_with_global_order_and_per_project_usage() {
  let (directory, storage) = service();
  let initial = state(
    1,
    "project-a",
    vec![
      project("project-a", "Alpha", Some("session-a2")),
      project("project-b", "Beta", Some("session-b1")),
    ],
    vec![
      session("session-a1", "project-a"),
      session("session-b1", "project-b"),
      session("session-a2", "project-a"),
    ],
    vec![
      document("session-a1", "project-a"),
      document("session-b1", "project-b"),
      document("session-a2", "project-a"),
    ],
  );
  storage
    .save_project_state(&initial, None)
    .expect("initial project save");
  let workspace_a = storage
    .workspace_create("project-a", None)
    .expect("project A workspace");
  let workspace_b = storage
    .workspace_create("project-b", None)
    .expect("project B workspace");
  storage
    .workspace_write(&workspace_a, "/alpha.txt", "abc", None)
    .expect("project A write");
  storage
    .workspace_write(&workspace_b, "/beta.txt", &"z".repeat(41), None)
    .expect("project B write");

  let usage_a = storage.project_usage("project-a").expect("project A usage");
  let usage_b = storage.project_usage("project-b").expect("project B usage");
  assert_eq!(usage_a.breakdown.workspace_bytes, 3);
  assert_eq!(usage_b.breakdown.workspace_bytes, 41);
  assert!(usage_a.database_bytes > usage_a.logical_bytes);
  assert!(usage_b.disk_bytes > 0);

  drop(storage);
  let reopened = initialized_service(directory.path().join("researchbox"));
  assert_eq!(
    reopened.load_project_state().expect("reopened state"),
    Some(initial)
  );
  assert_eq!(
    reopened
      .workspace_read(&workspace_a, "/alpha.txt")
      .expect("reopened workspace read")["content"],
    "abc"
  );

  let project_directories = std::fs::read_dir(directory.path().join("researchbox/projects"))
    .expect("projects directory")
    .collect::<Result<Vec<_>, _>>()
    .expect("project directory entries");
  assert_eq!(project_directories.len(), 2);
  assert!(project_directories.iter().all(|entry| {
    let name = entry.file_name().to_string_lossy().into_owned();
    name != "project-a" && name != "project-b"
  }));
}

#[test]
fn workspace_cas_revert_and_aba_guards_are_atomic() {
  let (_directory, storage) = service();
  let workspace = storage
    .workspace_create("project-1", None)
    .expect("workspace");
  assert_eq!(
    revision(
      &storage
        .workspace_write(
          &workspace,
          "/cas.txt",
          "one",
          Some(&WorkspaceWriteOptions {
            expected_content: ExpectedContent::Exact(None),
            change: None,
          }),
        )
        .expect("create-only write")
    ),
    1
  );
  let duplicate_create = storage.workspace_write(
    &workspace,
    "/cas.txt",
    "two",
    Some(&WorkspaceWriteOptions {
      expected_content: ExpectedContent::Exact(None),
      change: None,
    }),
  );
  assert!(matches!(
    duplicate_create,
    Err(StorageError::Vfs {
      code: "vfs_conflict",
      ..
    })
  ));

  let first_receipt = WorkspaceWriteOptions {
    expected_content: ExpectedContent::Exact(Some("one".into())),
    change: Some(change(
      "change-1",
      WorkspaceToolName::ReplaceText,
      "2026-07-28T00:00:00.000Z",
    )),
  };
  assert_eq!(
    revision(
      &storage
        .workspace_write(&workspace, "/cas.txt", "two", Some(&first_receipt))
        .expect("journaled update")
    ),
    2
  );
  storage
    .workspace_write(&workspace, "/cas.txt", "three", None)
    .expect("ABA away");
  storage
    .workspace_write(&workspace, "/cas.txt", "two", None)
    .expect("ABA back");
  assert!(matches!(
    storage.workspace_revert_change(&workspace, "change-1"),
    Err(StorageError::Vfs {
      code: "vfs_conflict",
      ..
    })
  ));

  let second_receipt = WorkspaceWriteOptions {
    expected_content: ExpectedContent::Exact(Some("two".into())),
    change: Some(change(
      "change-2",
      WorkspaceToolName::ReplaceText,
      "2026-07-28T00:00:00.000Z",
    )),
  };
  storage
    .workspace_write(&workspace, "/cas.txt", "four", Some(&second_receipt))
    .expect("second receipt");
  let reverted = storage
    .workspace_revert_change(&workspace, "change-2")
    .expect("first revert");
  assert_eq!(reverted["revert_outcome"], "applied");
  assert_eq!(
    storage
      .workspace_read(&workspace, "/cas.txt")
      .expect("restored content")["content"],
    "two"
  );
  let repeated = storage
    .workspace_revert_change(&workspace, "change-2")
    .expect("idempotent revert");
  assert_eq!(repeated["revert_outcome"], "already_reverted");
  assert_eq!(
    repeated["workspace_revision"],
    reverted["workspace_revision"]
  );
}

#[test]
fn deletion_reserves_revision_and_stales_old_handles_after_project_removal() {
  let (_directory, storage) = service();
  let first_state = state(
    1,
    "project-1",
    vec![project("project-1", "One", None)],
    vec![],
    vec![],
  );
  storage
    .save_project_state(&first_state, None)
    .expect("first state");
  let old_workspace = storage
    .workspace_create("project-1", None)
    .expect("old workspace");
  storage
    .workspace_write(&old_workspace, "/old.txt", "old", None)
    .expect("old write");

  let second_state = state(
    2,
    "project-2",
    vec![project("project-2", "Two", None)],
    vec![],
    vec![],
  );
  storage
    .save_project_state(&second_state, Some(1))
    .expect("remove project from state");
  storage
    .workspace_delete("project-1")
    .expect("delete removed project workspace");
  assert!(matches!(
    storage.workspace_read(&old_workspace, "/old.txt"),
    Err(StorageError::Vfs {
      code: "vfs_not_found",
      ..
    })
  ));
  let replacement = storage
    .workspace_create(
      "project-1",
      Some(&[crate::protocol::VfsSeedFile {
        path: "/new.txt".into(),
        content: "new".into(),
      }]),
    )
    .expect("replacement workspace");
  let replacement_read = storage
    .workspace_read(&replacement, "/new.txt")
    .expect("replacement baseline");
  assert_eq!(replacement_read["workspace_revision"], 2);
  assert_eq!(replacement_read["path_revision"], 2);
  assert!(matches!(
    storage.workspace_read(&old_workspace, "/new.txt"),
    Err(StorageError::Vfs {
      code: "vfs_conflict",
      ..
    })
  ));
}

#[test]
fn unicode_normalization_and_case_are_distinct_paths() {
  let (_directory, storage) = service();
  let workspace = storage
    .workspace_create(
      "unicode",
      Some(&[
        crate::protocol::VfsSeedFile {
          path: "/A.txt".into(),
          content: "upper".into(),
        },
        crate::protocol::VfsSeedFile {
          path: "/a.txt".into(),
          content: "lower".into(),
        },
        crate::protocol::VfsSeedFile {
          path: "/é.txt".into(),
          content: "composed".into(),
        },
        crate::protocol::VfsSeedFile {
          path: "/e\u{301}.txt".into(),
          content: "decomposed".into(),
        },
      ]),
    )
    .expect("unicode workspace");
  let snapshot = storage
    .workspace_read_files_snapshot(&workspace)
    .expect("unicode snapshot");
  assert_eq!(snapshot["files"].as_array().expect("files").len(), 4);
  assert_eq!(
    storage
      .workspace_read(&workspace, "/é.txt")
      .expect("composed read")["content"],
    "composed"
  );
  assert_eq!(
    storage
      .workspace_read(&workspace, "/e\u{301}.txt")
      .expect("decomposed read")["content"],
    "decomposed"
  );
}

#[test]
fn wire_seed_entries_reject_unknown_fields_after_lifecycle_precedence() {
  let (_directory, storage) = service();
  let unexpected_seed = vec![json!({
    "path": "/note.txt",
    "content": "note",
    "unexpected": true,
  })];
  assert!(matches!(
    storage.workspace_create_from_wire("strict-seed", Some(&unexpected_seed)),
    Err(StorageError::Vfs {
      code: "vfs_invalid_path",
      ..
    })
  ));

  let valid_seed = vec![json!({
    "path": "/note.txt",
    "content": "note",
  })];
  storage
    .workspace_create_from_wire("strict-seed", Some(&valid_seed))
    .expect("valid wire seed");
  assert!(matches!(
    storage.workspace_create_from_wire("strict-seed", Some(&unexpected_seed)),
    Err(StorageError::WorkspaceAlreadyExists(project_id))
      if project_id == "strict-seed"
  ));
}

#[test]
fn independent_services_serialize_project_revision_cas() {
  let directory = tempfile::tempdir().expect("temporary directory");
  let root = directory.path().join("researchbox");
  let first = initialized_service(root.clone());
  first
    .save_project_state(
      &state(
        1,
        "project-1",
        vec![project("project-1", "Initial", None)],
        vec![],
        vec![],
      ),
      None,
    )
    .expect("initial state");
  let second = initialized_service(root);
  let barrier = Arc::new(Barrier::new(2));

  let save = |service: StorageService, name: &'static str, barrier: Arc<Barrier>| {
    std::thread::spawn(move || {
      let candidate = state(
        2,
        "project-1",
        vec![project("project-1", name, None)],
        vec![],
        vec![],
      );
      barrier.wait();
      service.save_project_state(&candidate, Some(1))
    })
  };
  let left = save(first.clone(), "Left", barrier.clone());
  let right = save(second.clone(), "Right", barrier);
  let outcomes = [
    left.join().expect("left writer"),
    right.join().expect("right writer"),
  ];
  assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
  assert_eq!(
    outcomes
      .iter()
      .filter(|result| matches!(result, Err(StorageError::ProjectStoreConflict)))
      .count(),
    1
  );
  let loaded = first
    .load_project_state()
    .expect("coherent state")
    .expect("initialized state");
  assert_eq!(loaded["state_revision"], 2);
  assert!(loaded["projects"][0]["name"] == "Left" || loaded["projects"][0]["name"] == "Right");
}

#[test]
fn initialization_replays_a_durable_pending_project_save() {
  let (directory, storage) = service();
  let pending_state = state(
    1,
    "project-1",
    vec![project("project-1", "Recovered", None)],
    vec![],
    vec![],
  );
  let commit_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let journal_path = directory
    .path()
    .join("researchbox/staging/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json");
  std::fs::write(
    &journal_path,
    serde_json::to_vec(&pending_state).expect("pending state JSON"),
  )
  .expect("pending journal");
  let catalog = storage.open_catalog().expect("catalog");
  catalog
    .execute(
      "INSERT INTO pending_project_commit (id, commit_id, mappings_json)
       VALUES (1, ?1, ?2)",
      rusqlite::params![
        commit_id,
        r#"{"project-1":"11111111111111111111111111111111"}"#,
      ],
    )
    .expect("pending marker");
  drop(catalog);
  drop(storage);

  let reopened =
    StorageService::new(directory.path().join("researchbox")).expect("construct recovered storage");
  reopened.initialize().expect("recover pending storage");
  assert_eq!(
    reopened.load_project_state().expect("recovered state"),
    Some(pending_state)
  );
  assert!(!journal_path.exists());
  let catalog = reopened.open_catalog().expect("reopened catalog");
  let pending_count: u64 = catalog
    .query_row("SELECT COUNT(*) FROM pending_project_commit", [], |row| {
      row.get(0)
    })
    .expect("pending count");
  assert_eq!(pending_count, 0);
}

#[test]
fn orphan_reconciliation_preserves_a_project_published_by_pending_recovery() {
  let (directory, storage) = service();
  let workspace = storage
    .workspace_create("project-1", None)
    .expect("provisional workspace");
  storage
    .workspace_write(&workspace, "/kept.txt", "kept", None)
    .expect("provisional workspace write");
  let pending_state = state(
    1,
    "project-1",
    vec![project("project-1", "Recovered", None)],
    vec![],
    vec![],
  );
  let commit_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let journal_path = directory
    .path()
    .join("researchbox/staging/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json");
  std::fs::write(
    &journal_path,
    serde_json::to_vec(&pending_state).expect("pending state JSON"),
  )
  .expect("pending journal");
  let catalog = storage.open_catalog().expect("catalog");
  catalog
    .execute(
      "INSERT INTO pending_project_commit (id, commit_id, mappings_json)
       VALUES (1, ?1, ?2)",
      rusqlite::params![
        commit_id,
        json!({ "project-1": storage_id(&storage, "project-1") }).to_string(),
      ],
    )
    .expect("pending marker");
  drop(catalog);

  storage
    .workspace_reconcile_orphans(&[])
    .expect("stale orphan reconciliation");

  assert_eq!(
    storage.load_project_state().expect("published state"),
    Some(pending_state)
  );
  assert_eq!(
    storage
      .workspace_read(&workspace, "/kept.txt")
      .expect("workspace survived recovered commit")["content"],
    "kept"
  );
  assert!(!journal_path.exists());
}

#[test]
fn missing_mapped_project_database_is_corruption_and_is_not_recreated() {
  let (_directory, storage) = service();
  storage
    .workspace_create("project-1", None)
    .expect("workspace");
  let storage_id = storage_id(&storage, "project-1");
  let project_directory = storage.project_dir(&storage_id).expect("project directory");
  std::fs::remove_dir_all(&project_directory).expect("remove project database");

  assert!(matches!(
    storage.workspace_open("project-1"),
    Err(StorageError::WorkspaceCorruption(_))
  ));
  assert!(!project_directory.exists());
}

#[test]
fn persisted_storage_identifiers_are_validated_before_path_construction() {
  let (_directory, storage) = service();
  storage
    .workspace_create("project-1", None)
    .expect("workspace");
  let catalog = storage.open_catalog().expect("catalog");
  catalog
    .execute(
      "UPDATE project_storage SET storage_id = '../outside' WHERE project_id = ?1",
      ["project-1"],
    )
    .expect("corrupt storage id");
  drop(catalog);

  assert!(matches!(
    storage.workspace_open("project-1"),
    Err(StorageError::WorkspaceCorruption(_))
  ));
}

#[test]
fn malformed_receipt_cannot_mutate_before_reporting_corruption() {
  let (_directory, storage) = service();
  let workspace = storage
    .workspace_create(
      "project-1",
      Some(&[crate::protocol::VfsSeedFile {
        path: "/notes.txt".into(),
        content: "before".into(),
      }]),
    )
    .expect("workspace");
  storage
    .workspace_write(
      &workspace,
      "/notes.txt",
      "after",
      Some(&WorkspaceWriteOptions {
        expected_content: ExpectedContent::Exact(Some("before".into())),
        change: Some(change(
          "corrupt-change",
          WorkspaceToolName::ReplaceText,
          "2026-07-28T00:00:00.000Z",
        )),
      }),
    )
    .expect("journaled write");
  let storage_id = storage_id(&storage, "project-1");
  let connection = storage
    .open_project_database(&storage_id)
    .expect("project database");
  let record_json: String = connection
    .query_row(
      "SELECT record_json FROM workspace_changes WHERE change_id = ?1",
      ["corrupt-change"],
      |row| row.get(0),
    )
    .expect("receipt JSON");
  let mut record: Value = serde_json::from_str(&record_json).expect("receipt value");
  record["created_at"] = json!("not-a-timestamp");
  connection
    .execute(
      "UPDATE workspace_changes SET record_json = ?1 WHERE change_id = ?2",
      rusqlite::params![record.to_string(), "corrupt-change"],
    )
    .expect("corrupt receipt");
  drop(connection);

  assert!(matches!(
    storage.workspace_revert_change(&workspace, "corrupt-change"),
    Err(StorageError::WorkspaceCorruption(_))
  ));
  assert_eq!(
    storage
      .workspace_read(&workspace, "/notes.txt")
      .expect("unchanged file after rejected revert"),
    json!({
      "workspace_revision": 1,
      "path_revision": 1,
      "content": "after",
    })
  );
}

#[test]
fn construction_is_io_free_and_schema_versions_are_not_overwritten() {
  let directory = tempfile::tempdir().expect("temporary directory");
  let root = directory.path().join("researchbox");
  let storage = StorageService::new(root.clone()).expect("construct storage");
  assert!(!root.exists());
  storage.initialize().expect("initialize storage");
  let catalog = storage.open_catalog().expect("catalog");
  catalog
    .execute(
      "UPDATE native_meta SET value = '2' WHERE key = 'schema_version'",
      [],
    )
    .expect("install future schema marker");
  drop(catalog);

  assert!(matches!(
    storage.initialize(),
    Err(StorageError::WorkspaceCorruption(_))
  ));
  let raw_catalog = rusqlite::Connection::open(root.join("catalog.sqlite3")).expect("raw catalog");
  let version: String = raw_catalog
    .query_row(
      "SELECT value FROM native_meta WHERE key = 'schema_version'",
      [],
      |row| row.get(0),
    )
    .expect("schema version");
  assert_eq!(version, "2");
}

#[test]
fn incomplete_final_catalog_is_rejected_without_being_reinitialized() {
  let directory = tempfile::tempdir().expect("temporary directory");
  let root = directory.path().join("researchbox");
  std::fs::create_dir_all(&root).expect("storage root");
  let catalog_path = root.join("catalog.sqlite3");
  std::fs::File::create(&catalog_path).expect("incomplete catalog");
  let storage = StorageService::new(root).expect("construct storage");

  assert!(matches!(
    storage.initialize(),
    Err(StorageError::WorkspaceCorruption(_))
  ));
  assert_eq!(
    std::fs::metadata(catalog_path)
      .expect("incomplete catalog remains")
      .len(),
    0
  );
}

#[test]
fn malformed_project_state_is_rejected_before_overwriting_valid_state() {
  let (_directory, storage) = service();
  let initial = state(
    1,
    "project-1",
    vec![project("project-1", "Valid", None)],
    vec![],
    vec![],
  );
  storage
    .save_project_state(&initial, None)
    .expect("valid initial state");
  let mut malformed = state(
    2,
    "project-1",
    vec![project("project-1", "Invalid", None)],
    vec![],
    vec![],
  );
  malformed["projects"][0]
    .as_object_mut()
    .expect("project object")
    .remove("new_chat_model");

  assert!(matches!(
    storage.save_project_state(&malformed, Some(1)),
    Err(StorageError::InvalidRequest(_))
  ));
  assert_eq!(
    storage.load_project_state().expect("valid state remains"),
    Some(initial)
  );
}

#[test]
fn journaled_remove_can_be_reverted_once() {
  let (_directory, storage) = service();
  let workspace = storage.workspace_create("remove", None).expect("workspace");
  storage
    .workspace_write(&workspace, "/file.txt", "line\n", None)
    .expect("seed write");
  let removed = storage
    .workspace_remove(
      &workspace,
      "/file.txt",
      Some(&WorkspaceRemoveOptions {
        expected_content: Some("line\n".into()),
        change: Some(change(
          "remove-1",
          WorkspaceToolName::RemoveFile,
          "2026-07-28T00:00:00.000Z",
        )),
      }),
    )
    .expect("journaled remove");
  assert_eq!(removed["result"]["change"]["deletions"], 1);
  let reverted = storage
    .workspace_revert_change(&workspace, "remove-1")
    .expect("remove revert");
  assert_eq!(reverted["revert_outcome"], "applied");
  assert_eq!(
    storage
      .workspace_read(&workspace, "/file.txt")
      .expect("restored file")["content"],
    "line\n"
  );
}
