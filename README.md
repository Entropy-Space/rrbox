# ResearchBox

ResearchBox is a browser-native workspace for Pi agents. Its viewer, protocol,
agent runtime, model transport, and virtual filesystem are independent
workspace packages. The browser remains a first-class runtime, and the same
viewer and browser runtime now run in a Tauri 2 WebView composition targeting
macOS, iOS, and Android.

## Current vertical slice

- ChatGPT-style responsive conversation viewer with pauseable streaming
  auto-follow and an accessible jump-to-latest control
- Persistent projects, submitted chats, and project/session input drafts
- One virtual new-chat state per project; a session is created on first send
- Keyboard-accessible search across saved chats in every project
- Real `@earendil-works/pi-agent-core` loop inside a Web Worker
- Dedicated LLM Web Worker for multiplexed model requests and cancellation
- Chat-scoped provider/model picker with a built-in mock and dynamic
  OpenAI-compatible discovery at `localhost:4141` in both browser and Tauri
- Versioned, runtime-validated JSON commands and events
- Streaming mock-model service with a real tool-result continuation loop
- One canonical, ordered timeline that preserves reasoning, assistant text,
  tool calls, tool results, and multi-turn continuations exactly as they stream
- Project-isolated IndexedDB virtual filesystems with `list_files`, bounded
  literal `search_files`, `read_file`, `write_file`, exact-match
  `replace_text`, and reversible `remove_file` tools
- Opt-in, stateless `run_python` tool backed by RustPython: browsers lazily
  start an isolated Wasm Worker, while native lifecycle stays in Rust
- Opt-in, stateless `web_search` tool adapted from `pi-web-access`, with a
  provider-independent retrieval boundary, multi-query research, domain and
  recency filters, and optional active-model synthesis with citations
- App-private native persistence through a Rust-owned catalog and one
  transactional SQLite database per project
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
  app-runtime-browser/ Shared browser/WebView core composition and locking
  runtime-browser/     Core and LLM Web Worker hosts and transports
  storage-browser/     IndexedDB and OPFS project/workspace adapters
  storage-native/      Typed native-storage RPC client and adapters
  provider-native/     Typed native-provider HTTP streaming RPC client
  mock-provider/       Framework-neutral mock model request handler
  vfs/                 Workspace capabilities, errors, and adapters
  vfs-testkit/         Shared backend conformance suite
  workspace-archive/   Deterministic workspace ZIP capture and codec
  project-store/       Project/session records and persistence contract
  python-plugin/       Opt-in Python tool, protocol, Rust core, and Wasm
  web-search-plugin/   Clean, stateless pi-web-access search fork
```

Applications are composition roots. Reusable packages do not import Next.js,
Vinext, Tauri, or application files. Both roots mount the shared viewer through
the same Worker transport and core composition. The browser injects
IndexedDB/OPFS storage; the native root injects a typed MessagePort/Tauri/Rust
storage boundary. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the dependency
rules.

## Requirements

- Node.js 22.19 or newer
- pnpm 10.30.3
- Rust 1.93 or newer for native validation and RustPython/Wasm development
- `wasm-pack` 0.13 or newer and the `wasm32-unknown-unknown` Rust target

## Development

```bash
pnpm install
pnpm run build:python-wasm
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

The OpenAI-compatible provider expects `GET /v1/models` and streaming
`POST /v1/chat/completions` on `http://127.0.0.1:4141`. The local web server
exposes only those two calls through same-origin routes because the browser
cannot assume the gateway enables CORS. The mock provider remains available
when the local gateway is stopped. Set `RESEARCHBOX_LOCAL_OPENAI_BASE_URL` to
override the web proxy's local base URL during development. The native bridge
remains fixed to loopback until configurable endpoint and credential policy is
defined.

Python is composed explicitly by each application rather than built into the
core. Every `run_python` call starts a fresh interpreter, so globals do not
persist. Browser code creates the Python Worker and loads RustPython Wasm only
on first use. Native code crosses a private typed `MessagePort` and Tauri
command boundary so Rust owns execution, timeout, cancellation, and teardown.
Network requests and direct workspace access are not exposed to Python yet.
Open **Plugins** in the application sidebar to enable Python and configure its
per-call execution timeout and combined output limit. Plugin settings are
stored on the local device, and saving them restarts the local core so the
agent's tool list updates immediately.

Web search is also opt-in from **Plugins**. The cleaned integration exposes
only `web_search`; it does not include upstream page fetching, local paths,
browser-cookie access, curator servers, session storage, cloning, or video/PDF
pipelines. It accepts one focused query or up to four varied queries, optional
domain and recency filters, and raw, automatic-summary, or reviewed-summary
workflows. Reviewed summary opens its in-app curator before retrieval and
streams each completed query/provider result into a separate evidence card.
The running tool card also reports retrieval, synthesis, and approval phases.
Once retrieval finishes, it automatically generates the first draft from all
successful cards, then allows editing, Markdown preview, regeneration with
feedback, changing the summary provider/model, approval, or returning to
evidence selection. While selecting evidence, another bounded search angle can
be entered directly or improved with the selected summary model before
retrieval.
These query drafts and added searches exist only for the active tool call.
The draft reports the model actually used, generation time,
estimated tokens, and deterministic fallback reason. The review exists only
while the tool call is active. Its configurable review deadline begins after
initial retrieval, so slow providers do not consume the user's review time.
If review remains unresolved, its pending interaction is cancelled and the
selected evidence is returned as a deterministic cited digest. Automatic
summary uses the chat's active model.
A reviewed summary may use any ready model; if an explicit choice fails, it
retries with the active model before producing a deterministic, source-linked
digest. Retrieval is routed through a provider interface; Exa MCP is currently
available in both applications, while native also offers anonymous AnySearch
through a fixed-endpoint Rust service. Automatic routing falls back only for
transient, quota, or network failures; native settings can choose the provider
order. **All available** merges bounded, URL-deduplicated results with
round-robin source diversity while preserving each provider as an independent
review card; failed providers remain visible but cannot be selected. Searches
have explicit result, response-size,
synthesis, and timeout bounds and retain no state. See
`packages/web-search-plugin/THIRD_PARTY_NOTICES.md` for the MIT-licensed
upstream attribution.

### Native app

Build the shared static frontend without opening a native window:

```bash
pnpm build:native
pnpm check:native
```

Run the macOS desktop app:

```bash
pnpm dev:native
```

The native runtime stores its catalog and project data below Tauri's
application-data directory. The catalog keeps project ordering, selection,
lifecycle state, and opaque project-directory mappings. Each project owns a
separate SQLite database containing its sessions, drafts, workspace content,
revisions, tombstones, and change receipts. A synced staging journal makes a
global project-state save replayable before its new revision becomes visible.

Existing experimental IndexedDB/OPFS data from an older native build is left
untouched but is not migrated automatically yet. It also remains separate from
the browser app at `http://localhost:3000`. The native model picker offers the
in-process mock and the fixed OpenAI-compatible endpoint at
`http://127.0.0.1:4141/v1`; Rust owns its bounded HTTP streaming and
cancellation.

The generated iOS project is checked in at
`apps/native/src-tauri/gen/apple`; its build products, Rust library, and
per-user Xcode state remain ignored. The generated Android project is not
checked in yet. Initialize Android only on a machine with the relevant
toolchain:

```bash
pnpm --filter @researchbox/native tauri android init
```

Build or run the Apple Silicon iOS Simulator target after installing Xcode's
iOS Simulator runtime:

```bash
pnpm build:native:ios-sim
pnpm dev:native:ios
```

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test` builds both application frontends, checks and tests the Rust host,
and runs the shared browser/package test suites.

## Deployment policy

Keep this repository local unless the user explicitly selects and authorizes a
deployment target. Never publish ResearchBox to `chatgpt.site`.

## Storage

The browser storage package stores project metadata, drafts, normalized session
timelines, transactional file manifests, undo-ready change receipts, and
workspace revisions in one versioned IndexedDB database. When the current
origin can successfully create and close an OPFS writable stream, immutable
content-addressed UTF-8 file objects live in OPFS; otherwise new workspaces keep
their content inline in IndexedDB. A new chat remains project-scoped draft state
until its first prompt; its selected model, staged user timeline entry, session,
and cleared project draft commit atomically before model transport starts.
Existing chats retain their own model selection.

Browser storage remains origin-local. Native storage is instead application
private and independent of the WebView origin, so development and packaged
native builds resolve the same host-managed store. ResearchBox currently
performs no automatic browser-to-native migration. Native provider networking
uses a separate typed Tauri boundary and does not change the viewer/core or
canonical model-event protocols.

The native core still runs in a dedicated Web Worker. It sends versioned,
snake_case storage requests over a private `MessagePort`; a main-thread broker
invokes one Tauri command, and a Rust service owns validation, recovery,
locking, and SQLite transactions. The service uses a small catalog plus opaque
per-project directories. A durable staging payload and catalog commit marker
make interrupted global saves replayable without allowing transcript payloads
to inflate the catalog database. Workspace mutations update content, path
generation, optional receipt, receipt clock, and revision in one project-local
transaction.

Native usage reporting distinguishes logical project bytes, SQLite database
bytes, total on-disk bytes, and workspace/conversation/history/overhead
categories. The typed API is implemented; viewer presentation and quota policy
remain separate product work.

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
conformance suite. The native backend implements the same structural workspace
contract over SQLite, while ZIP remains a portable import/export codec rather
than a live filesystem backend. Workspace paths are case-sensitive Unicode
logical paths; physical OPFS names are opaque hashes and native logical names
are database keys, so host filename normalization cannot collapse them. Every
workspace operation returns a durable content revision from the same atomic
read or mutation; revisions include unjournaled writes and removals and
therefore are not derived from change-receipt count. Recreating a deleted
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
