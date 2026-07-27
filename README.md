# ResearchBox

ResearchBox is a browser-native workspace for Pi agents. Its viewer, protocol,
agent runtime, model transport, and virtual filesystem are independent
workspace packages. The browser remains a first-class runtime, while one
Tauri 2 composition root prepares the same product for macOS, iOS, and Android.

## Current vertical slice

- ChatGPT-style responsive conversation viewer with pauseable streaming
  auto-follow and an accessible jump-to-latest control
- Persistent projects, submitted chats, and project/session input drafts
- One virtual new-chat state per project; a session is created on first send
- Keyboard-accessible search across saved chats in every project
- Real `@earendil-works/pi-agent-core` loop inside a Web Worker
- Dedicated LLM Web Worker for multiplexed model requests and cancellation
- Chat-scoped provider/model picker with a built-in mock and dynamic
  OpenAI-compatible discovery at `localhost:4141`
- Versioned, runtime-validated JSON commands and events
- Streaming mock-model service with a real tool-result continuation loop
- One canonical, ordered timeline that preserves reasoning, assistant text,
  tool calls, tool results, and multi-turn continuations exactly as they stream
- Project-isolated IndexedDB virtual filesystems with `list_files`, bounded
  literal `search_files`, `read_file`, `write_file`, exact-match
  `replace_text`, and reversible `remove_file` tools
- Atomic file-change receipts with line statistics, live workspace refresh, and
  reload recovery when a mutation commits before its transcript checkpoint
- Exact before/after change review with a bounded unified diff and a confirmed,
  conflict-safe one-time revert
- Versioned timeline checkpoints that restore the supported text and tool
  surface back into Pi messages after reload
- Interactive workspace browser and text-file preview
- Deterministic, content-only workspace archive import and export for browser
  projects

## Repository structure

```text
apps/
  web/                 Vinext browser composition root and worker entries
  native/              Tauri 2 composition root for macOS, iOS, and Android

packages/
  client/              Platform-neutral viewer/core transport contract
  protocol/            Serialized viewer/core contract and validators
  agent-core/          Pi agent orchestration and tools
  viewer/              React conversation and workspace UI
  model-transport/     Model request/stream contract and HTTP adapter
  runtime-browser/     Core and LLM Web Worker hosts and transports
  storage-browser/     IndexedDB and OPFS project/workspace adapters
  mock-provider/       Framework-neutral mock model request handler
  vfs/                 Workspace capabilities, errors, and adapters
  vfs-testkit/         Shared backend conformance suite
  workspace-archive/   Deterministic workspace ZIP capture and codec
  project-store/       Project/session records and persistence contract
```

Applications are composition roots. Reusable packages do not import Next.js,
Vinext, Tauri, or application files. The native root currently proves the
static shell and build boundary; connecting the shared viewer through typed
Tauri IPC is the next native milestone. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the dependency rules.

## Requirements

- Node.js 22.19 or newer
- pnpm 10.30.3
- Rust 1.85 or newer for native validation and development

## Development

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

The OpenAI-compatible provider expects `GET /v1/models` and streaming
`POST /v1/chat/completions` on `http://127.0.0.1:4141`. The local web server
exposes only those two calls through same-origin routes because the browser
cannot assume the gateway enables CORS. The mock provider remains available
when the local gateway is stopped. Set `RESEARCHBOX_LOCAL_OPENAI_BASE_URL` to
override the local base URL during development.

### Native shell

Build the shared static frontend without opening a native window:

```bash
pnpm build:native
pnpm check:native
```

Run the macOS desktop shell:

```bash
pnpm dev:native
```

Tauri's generated Android and iOS projects are intentionally not checked in
yet. Initialize them from `apps/native` only on a machine with the relevant
mobile toolchain:

```bash
pnpm --filter @researchbox/native tauri android init
pnpm --filter @researchbox/native tauri ios init
```

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test` builds both application frontends, checks the Rust host, and runs
the shared browser/package test suites.

## Deployment policy

Keep this repository local unless the user explicitly selects and authorizes a
deployment target. Never publish ResearchBox to `chatgpt.site`.

## Storage

The browser storage package stores project metadata, drafts, normalized session
timelines, transactional file manifests, undo-ready change receipts, and
workspace revisions in one versioned IndexedDB database. When the browser can
successfully create and close an OPFS writable stream, immutable
content-addressed UTF-8 file objects live in OPFS; otherwise new workspaces keep
their content inline in IndexedDB. A new chat remains project-scoped draft state
until its first prompt; its selected model, staged user timeline entry, session,
and cleared project draft commit atomically before model transport starts.
Existing chats retain their own model selection.

An OPFS mutation closes its immutable object before one IndexedDB transaction
publishes the new manifest pointer, optional receipt, monotonic receipt clock,
path generation, and durable revision. Reverting a receipt is one atomic
operation: it verifies that the path is still the exact generation written by
that receipt, restores or removes the file, and permanently marks the receipt
consumed. This rejects edit-away/edit-back ABA cycles and ensures a later file
is never changed even if its bytes happen to match an older agent edit. Legacy
receipts without a provable path generation remain reviewable but fail closed
for revert. Failed OPFS publication leaves an unreachable object, never a
partially committed workspace; durable cleanup records remove those objects
under an origin-wide storage lock. Existing inline workspaces migrate
resumably: IndexedDB remains authoritative while candidate objects are copied,
then one transaction verifies the source revision and exact path coverage
before flipping ownership without changing the workspace revision. Versioned
storage migrations backfill the only revision baseline recoverable from older
receipt journals.

Provider discovery starts independently from workspace ownership. Every browser
tab creates its own stateful core immediately, keeps navigation local, and
receives revision invalidations from other tabs. IndexedDB mutations rebase
against canonical state inside short transactions instead of rewriting a stale
snapshot. Web Locks are held only around the commands that need coordination:
catalog lifecycle changes serialize briefly, prompts serialize per session,
project deletion waits for that project's active runs, and unrelated projects
and sessions remain independent. Local navigation takes only a shared lifecycle
gate for its target project. Provider discovery, refresh, and abort do not wait
for storage coordination.

Ordinary OPFS work similarly holds a per-project exclusive lock beneath a shared
origin gate. Crash cleanup and orphan reconciliation retain exclusive access to
that gate because they scan storage globally. The original origin lock name
remains in use as the gate so an already-open tab from an older bundle cannot
race the refined locking scheme.

The memory, inline IndexedDB, and hybrid OPFS workspace backends run the same
conformance suite. Native-folder and iOS backends can implement the same
structural workspace capabilities. ZIP is a portable import/export codec rather
than a live filesystem backend. Workspace paths are case-sensitive Unicode
logical paths; physical OPFS names are opaque hashes, and native adapters may
encode names to preserve collisions that the host filesystem cannot represent
directly. Every workspace operation returns a durable content revision from the
same atomic read or mutation; revisions include unjournaled writes and removals
and therefore are not derived from change-receipt count. Recreating a deleted
project id continues its sequence through a durable tombstone instead of
resetting cached content to an apparently older revision.

`search_files` captures one coherent workspace revision, searches a file or
directory in deterministic path order, and returns bounded line previews with
Unicode-aware positions. It is a portable TypeScript tool and requires neither
a host shell nor Bun, so the same contract can run entirely in a browser.

Archive export uses each browser backend's revision-stable bulk snapshot
capability, avoiding recursive listings and repeated full-project reads. On
startup, browser storage also reconciles active workspace records against the
persisted project catalog, removing crash-orphaned content while preserving
revision tombstones.

Workspace archive format v1 stores `researchbox-workspace.json` at the ZIP root
and UTF-8 file payloads below `workspace/`. Equivalent snapshots produce
byte-identical archives: entries are path-sorted, uncompressed (ZIP STORE), and
use fixed metadata. Import validates bounded archive, manifest, file, content,
and path sizes; requires an exact safe layout; and verifies CRC-32, SHA-256,
and UTF-8 integrity. The archive transfers file content only. Source workspace
revisions, change receipts, history, projects, and sessions are excluded.

Decoding returns sorted files suitable for
`backend.create(new_project_id, { initial_files: decoded.files })`. Those files
form the new workspace's revision-zero baseline and create no change receipts,
regardless of the source revision. An explicit `initial_files: []` creates an
empty baseline; omitting `initial_files` retains the backend's configured
default seed. The browser UI exposes Import beside the Projects heading and
Export in each project menu. The import picker, core export capture, and
archive-worker phases are cancellable, and the web composition uses a
conservative 16 MiB archive/content ceiling for iOS and other
memory-constrained browsers.
