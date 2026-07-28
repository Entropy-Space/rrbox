# ResearchBox native

This Tauri 2 composition root targets macOS, iOS, and Android with one
statically bundled React surface. It mounts the shared `ResearchBoxViewer`,
starts the shared browser core in a Web Worker, and uses a second Worker for
model requests.

The native runtime uses app-private host storage instead of WebView
IndexedDB/OPFS. Its core Worker sends typed requests over a transferred
`MessagePort`; the WebView host brokers them to one async Tauri command, and a
Rust service owns recovery, locking, and SQLite transactions.

The native layout is:

```text
<app-data>/researchbox/
├── catalog.sqlite3
├── projects/
│   └── <opaque-storage-id>/
│       └── project.sqlite3
├── staging/
└── trash/
```

The catalog stores the global project revision, ordering, selection, lifecycle
markers, and the mapping from logical project IDs to opaque directories. Each
project database stores that project's metadata, chats, drafts, workspace
content, revisions, tombstones, and change receipts. A synced staging journal
makes an interrupted cross-database project-state save replayable before its
catalog revision becomes visible. Project-local reads and writes use SQLite
transactions; catalog and lifecycle recovery is protected from a second
process by an advisory storage lock.

The typed storage client can report logical, database, and on-disk usage for
each project with a workspace/conversation/history/overhead breakdown. Usage is
not displayed in the viewer yet.

Existing experimental native IndexedDB/OPFS data remains untouched but is not
migrated automatically. Browser data at `http://localhost:3000` is separate.
Only the in-process mock provider is enabled; native provider networking is the
next platform boundary.

Run the native app during development from the repository root:

```bash
pnpm dev:native
```

Build the static frontend or packaged application:

```bash
pnpm --filter @researchbox/native build
pnpm --filter @researchbox/native tauri build
```

Validate the Rust storage service:

```bash
cargo test --manifest-path apps/native/src-tauri/Cargo.toml
```

The repository-wide `pnpm test` also enables a non-default test-harness feature
and runs the native SQLite backend through the same 30-case workspace and
durability conformance suites as the browser backends. The line-oriented
harness binary is feature-gated and is not included in normal native builds.

Initialize generated mobile projects only on a development machine with the
relevant platform SDK:

```bash
pnpm --filter @researchbox/native tauri android init
pnpm --filter @researchbox/native tauri ios init
```
