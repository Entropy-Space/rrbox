# ResearchBox architecture

## Runtime flow

```text
apps/web
  ├─ packages/viewer
  │    ├─ packages/client ───────────┐
  │    └─ packages/protocol          │ typed commands/events
  │                                  │
  ├─ WorkerCoreTransport ────────────┘
  │    └─ browser/core.worker.ts
  │         └─ packages/app-runtime-browser
  │              ├─ packages/runtime-browser
  │              ├─ packages/storage-browser
  │              ├─ packages/agent-core
  │              │    ├─ packages/protocol
  │              │    ├─ packages/model-transport
  │              │    ├─ packages/project-store
  │              │    └─ packages/vfs
  │              └─ worker model transport
  │                   │ versioned JSON, multiplexed by stream_id
  │                   ▼
  │                 browser/llm.worker.ts
  │                   ├─ packages/runtime-browser LLM host
  │                   ├─ mock NDJSON transport → /api/mock
  │                   └─ OpenAI-compatible SSE transport
  │                         └─ same-origin bridge → localhost:4141/v1
  └─ thin web routes
       └─ packages/mock-provider
```

The native composition is deliberately a separate application root:

```text
apps/native (Tauri 2)
  ├─ packages/viewer
  │    └─ packages/client + packages/protocol
  ├─ WorkerCoreTransport
  │    └─ workers/core.worker.ts
  │         ├─ packages/app-runtime-browser
  │         │    ├─ packages/agent-core
  │         │    └─ WorkerModelTransport → workers/llm.worker.ts
  │         │         ├─ in-process packages/mock-provider handler
  │         │         └─ packages/provider-native OpenAI transport
  │         │              └─ typed MessagePort RPC
  │         │                   └─ WebView broker → Tauri Channel
  │         └─ packages/storage-native
  │              └─ typed MessagePort RPC
  │                   └─ WebView broker → Tauri invoke
  └─ Rust host
       ├─ NativeStorageService
       │    ├─ catalog.sqlite3
       │    └─ projects/<opaque-storage-id>/project.sqlite3
       └─ ProviderService
            └─ fixed HTTP routes → 127.0.0.1:4141/v1
```

Both application roots mount the same viewer and core composition. The web root
injects IndexedDB/OPFS storage and enables the mock and local
OpenAI-compatible providers. The native root injects the native storage
adapters and enables the same provider choices through a distinct native
network boundary.

Native projects live below Tauri's application-data directory, independently
of the WebView origin. Existing experimental WebView IndexedDB/OPFS data is
left untouched but is not migrated automatically. Typed Tauri provider
networking uses a second private `MessagePort` and Tauri Channel. Neither
storage nor provider injection changes `CoreTransport` or the viewer/core JSON
protocol.

Tauri `invoke` belongs to the WebView host rather than the dedicated core
Worker. Native composition therefore transfers a private `MessagePort` before
admitting core commands. The Worker-side RPC client validates and correlates
responses; the main-thread broker validates requests and invokes one versioned
Rust command. Closing `WorkerCoreTransport` drains the core, terminates the
Worker, and closes the broker port.

The current single-WebView native composition uses Web Locks when WKWebView
provides them and otherwise preserves command ordering with a process-local
shared/exclusive lock manager. That fallback does not coordinate multiple
windows; a future multi-window native composition must move coordination behind
the typed host boundary.

Browser-only workspace transfer stays beside that JSON boundary:

```text
packages/viewer → browser workspace adapter → browser/archive.worker.ts
                                              └─ packages/workspace-archive
```

The viewer depends on `CoreTransport`, not on `Worker`. Both applications
construct `WorkerCoreTransport`, which validates all incoming protocol values,
isolates subscribers, and owns worker teardown. The viewer and core worker
exchange only protocol-v20 JSON values. Transport shutdown uses a separate
versioned control envelope: it asks the worker to abort and drain the core,
waits for disposal acknowledgement, and force-terminates after a bounded
timeout if cleanup cannot finish. A
`project_id` plus nullable `session_id` scopes the active composer: `null`
identifies that project's single virtual new chat, while incremental run events
always identify a durable session. Filesystem and draft acknowledgements use a
required request identifier, while authoritative snapshots use a monotonic
state revision. Every workspace operation also carries a project-scoped
`workspace_revision` captured atomically with the data it read or the mutation
it committed. This is a backend content version, independent from the number
of change receipts. Mutation events identify the changed path so the viewer can
refresh its directory and selected file without accepting stale responses.
Correlated change-read events expose the durable before/after receipt plus the
current file state. A revert event distinguishes a newly applied revert from an
idempotent replay. Together these prevent late work from replacing a newer
project, chat, draft, or file-navigation result. The core and LLM workers use a
separate protocol-v6 JSON contract so provider discovery, full conversation
requests, provider I/O, cancellation, and future credentials stay outside the
agent runtime. The viewer never imports Pi, filesystem implementations, model
transports, or either worker runtime.

The LLM worker is an isolation and lifecycle boundary, not a security boundary
against same-origin code. Server-held credentials must remain on the server.

## Dependency rules

1. `apps/web` owns Vinext integration, browser worker entry points, and browser
   composition.
2. `apps/native` owns Tauri integration and native composition. It does not
   become a dependency of a shared package.
3. `packages/client` owns the platform-neutral viewer/core transport contract.
   Concrete transports belong to runtime or application packages.
4. `packages/mock-provider` owns mock-model behavior and is mounted by a thin
   web route or invoked in-process by the native LLM worker.
5. `packages/viewer` depends only on React, UI primitives, the client contract,
   and the protocol. It does not construct workers.
6. `packages/app-runtime-browser` composes the browser/WebView core lifecycle,
   command locking, seed data, provider definitions, and a replaceable storage
   service factory. Its default factory uses browser storage. It imports no
   application root or framework.
7. `packages/agent-core` contains a project/session manager above an optional
   active Pi session runtime and depends only on abstract model, project-store,
   and VFS contracts.
8. `packages/runtime-browser` hosts compatible core and LLM handlers plus the
   Web Worker transport; it does not construct ResearchBox, select providers,
   or import Pi.
9. `packages/storage-browser` owns concrete IndexedDB and OPFS adapters.
   `packages/storage-native` owns the typed native storage RPC client plus
   `ProjectStore` and `WorkspaceBackend` façades.
   `packages/provider-native` owns the typed native provider RPC client and
   constrained fetch adapter. None is imported by the portable core.
10. The native application owns Tauri `invoke` and the WebView-side
    `MessagePort` broker. The shared native storage package has no Tauri
    dependency.
11. `packages/model-transport`, `packages/protocol`, `packages/project-store`,
    `packages/vfs`, and `packages/workspace-archive` have no application or
    framework dependencies. The archive codec depends on VFS reader and seed
    types, not on a concrete backend.
12. Applications compose packages; shared packages never import an application
    or platform host.
13. Optional agent plugins are injected into `packages/agent-core`. The core
    owns their session-bound tool definitions, while application composition
    owns executor resources and teardown.
14. Model transport accepts strictly named, JSON-schema-defined tools from the
    active agent registry. It does not keep a separate fixed allowlist that
    could silently remove application-composed plugin tools.

## Web search plugin boundary

`packages/web-search-plugin` is a stateless adaptation of the MIT-licensed
`pi-web-access` search workflow. It defines one `web_search` tool, a
provider-independent routing executor, and provider adapters used by both
browser and native core Workers. Exa MCP is available in both applications.
The native application also exposes anonymous AnySearch through a dedicated
MessagePort and a fixed-endpoint Rust service because the REST endpoint is not
a browser-CORS boundary. AnySearch is explicit-only and is not included by the
`all` route, matching the upstream provider contract. The plugin is absent
unless application composition enables it.

The tool supports a single query or a bounded batch of varied queries, domain
and recency filters, larger inline excerpts, explicit provider selection, and
raw, automatic-summary, or summary-review workflows. Search results are
normalized into provider-independent answers and source records before
rendering. Bounded partial tool updates expose retrieval, synthesis, and
approval phases on the running tool card. Automatic summary calls the active
session model through a constrained completion hook. During reviewed
synthesis, the viewer may choose
any ready provider/model from the live catalog; the core resolves that choice
instead of accepting an arbitrary model descriptor. A failed explicit choice
retries once with the active model under the same deadline before producing a
deterministic source-linked summary. The summary-review workflow opens one
updateable interaction before retrieval; completed query/provider results
stream into that interaction while submission controls remain unavailable.
After retrieval, the plugin automatically generates an initial draft from all
successful cards and updates the same interaction into summary review. It
distinguishes active retrieval from active synthesis on the protocol boundary:
provider changes may supersede retrieval, while provider changes or added
searches may abort and supersede draft generation without discarding completed
evidence.
It reports the actual model, duration, token estimate, and fallback reason, and
allows editing, Markdown preview, regeneration with feedback, changing models,
returning to evidence selection, approval, or cancellation. Only selected
evidence reaches later regeneration. During evidence selection, the viewer can
switch among currently available search providers to add independently
selectable evidence for the current query set, improve a bounded query with the
selected summary model, or add another bounded search with the active search
provider; neither query drafts nor results persist after the tool call. These
internal model calls use the same model transport and cancellation boundary as
the active agent. Each actionable review interaction also has a bounded idle
timeout; initial retrieval does not consume that window. Throttled,
interaction-scoped viewer activity resets it, so active
editing does not expire; stale activity is ignored without reviving a closed
interaction. Idle expiry aborts and clears the pending core interaction before
the plugin returns a deterministic summary of the current selection.

The router supports an explicit provider, configurable ordered automatic
fallback for transient, quota, and network failures, or bounded all-provider
aggregation with round-robin source diversity, URL deduplication, and
partial-failure diagnostics. Aggregated responses retain their structured
provider entries so review exposes each success independently and renders
provider failures as non-selectable evidence. Each provider validates query
and result bounds before networking, combines caller cancellation with a
configured timeout, bounds its response before decoding it, and limits
normalized source content to the configured budget. Both provider adapters
have one compiled outbound destination and reject redirects. Native AnySearch
does not forward provider error bodies because quota responses can contain
generated credentials. The router and tool retain no search results,
credentials, or session state.

The fork intentionally excludes upstream URL fetching, arbitrary/local paths,
browser cookies, API-key configuration, curator servers, persistent result
storage, repository cloning, and media extraction. Its curator is an
updateable, in-viewer, session-bound protocol interaction rather than an HTTP
server and retains no review state after the active tool call. Additional
providers and ordered
fallback can be added behind the routing interface without changing the tool
contract. Adding content fetching later requires a separate SSRF and redirect
policy; it must not be smuggled through the search tool.

## Python plugin boundary

`packages/python-plugin` defines the `run_python` tool, a strict versioned
execution protocol, the shared RustPython execution core, and browser/native
executor adapters. The plugin is absent unless an application passes it to the
core worker composition.

Each call is stateless and starts a fresh RustPython interpreter. The Python
surface has no ResearchBox workspace bridge or request API in this version.
Stdout, stderr, exceptions, execution time, source size, and combined output
are bounded at the execution boundary.

The browser executor creates a dedicated Worker only for the first Python
call. That Worker lazily instantiates the RustPython Wasm module and may be
reused, but not its interpreter state. Aborting or timing out execution
terminates the Worker; a later call creates a clean replacement.

The native core Worker sends Python operations over a private `MessagePort`.
The WebView broker invokes typed Tauri commands, and `PythonService` owns the
blocking RustPython task registry. RustPython's user-signal channel interrupts
active bytecode on cancellation or timeout. Closing the core transport closes
the broker and requests cancellation for every active native operation.

The shared viewer exposes an application-level Plugins page. Its strict
versioned settings document is stored locally and defaults Python to disabled.
Web and native composition roots resolve that document into the same bounded
runtime configuration. Saving a change recycles the core transport; project
and workspace persistence remain owned by their existing storage services.

## Serialization

All JSON protocol and model-transport fields use `snake_case`. TypeScript type,
function, and class names use the language's normal casing conventions.

The viewer/core and core/LLM protocols evolve independently. `stream_id`
correlates concurrent LLM requests and must not be reused as an agent session
identifier.

## Provider boundary

The web LLM worker routes the deterministic mock provider and an
OpenAI-compatible provider whose models are discovered dynamically from
`localhost:4141`. It is started before workspace bootstrap. A platform-neutral
`ProviderCatalogService` in the browser runtime owns normalized availability,
capabilities, refresh coalescing, and model lookup while the LLM worker remains
the trusted home of provider endpoints and request adapters.

Catalog discovery and refresh are read-only and never require the workspace
writer lock. Provider catalog snapshots carry their own monotonic
`catalog_revision`, independent from persisted workspace `state_revision`. A
model request contains the selected provider/model, system prompt, ordered
assistant content blocks, tool results, tool schemas, and optional reasoning
effort. The LLM worker normalizes provider output into validated text,
reasoning, and tool-call lifecycle events with monotonically increasing content
indices. OpenAI SSE fragments are assembled there before those ordered events
are returned to the active core. The viewer receives only validated
provider/model summaries.

Provider URLs are application configuration, never viewer input. For the
current local web runtime, two narrow same-origin server routes bridge model
discovery and chat completions to `127.0.0.1:4141`; this avoids relying on CORS
without turning the route into a general proxy. No provider credentials are
stored yet. A future fully browser-only composition can replace the bridge with
a CORS-capable local gateway or an in-browser/Wasm provider adapter without
changing the core/viewer protocol.

The native LLM worker also keeps the deterministic mock handler in-process.
For `local-openai`, it sends fixed-route fetch operations over a transferred
`MessagePort`; the WebView broker invokes Rust and relays ordered status,
filtered headers, raw body chunks, and terminal events over a Tauri Channel.
Rust permits only `GET /models` and `POST /chat/completions` at the fixed
loopback base, disables redirects and ambient proxies, bounds bodies and
timeouts, and owns cancellation. The existing TypeScript
`OpenAiCompatibleModelTransport` remains the sole JSON/SSE/tool-call parser, so
browser and native provider output normalize identically.

## Project and session persistence

The browser/WebView runtime attaches its JSON command coordinator and creates
its stateful core immediately. Provider refresh commands remain available while
workspace commands wait for bootstrap to complete.

Each browser/WebView core owns one IndexedDB database with `meta`, `projects`,
`sessions`, `session_documents`, `project_filesystems`, `files`,
`file_path_tombstones`, `file_changes`, `file_change_quarantines`, and
`opfs_files` stores. Project-store mutations read the canonical state inside
one short read-write transaction, apply a synchronous intent, update only
changed rows, and advance one monotonic `state_revision`. Draft writes use the
same revision sequence, so a later catalog or transcript commit cannot silently
replace a newer draft. Active project and session selection is worker-local;
the viewer restores that tab's cursor through `sessionStorage` in the bootstrap
command, and navigation does not write shared project state. Session documents
use format 4 to persist the existing-session input draft and one versioned,
ordered timeline. Format-3 timelines are upgraded once by deriving a legacy
file-change tool identity only from their enclosing mutation result.
Assistant entries own ordered text, reasoning, and tool-call blocks; tool
results are separate entries linked by internal block identifiers. That timeline
is the viewer state and maps back into the currently supported text-only user
and tool-result Pi surface. Projects persist their virtual new-chat draft and
model selection; durable sessions persist their own model selection.

Native persistence implements the same `ProjectStore` snapshot and workspace
contracts across one catalog and one database per project. The catalog owns the
global revision, active selection, project ordering, lifecycle markers, and
stable logical-ID-to-opaque-directory mapping. Project databases own their
project record, sessions, documents, drafts, workspace files, path generations,
receipts, and workspace lifecycle metadata.

A global project-state save cannot use one SQLite transaction across those
files. Before changing a project database, the Rust service writes and
synchronizes a staging payload, then commits a small catalog marker containing
the commit identifier and frozen project mapping. Applying each project
fragment is idempotent. Only after every fragment succeeds does a catalog
transaction publish the new global revision and remove the marker. Startup,
load, and save replay a surviving marker before exposing state; orphan staging
payloads are collectible. Keeping the large payload outside
`catalog.sqlite3` prevents transient conversation data from permanently
inflating catalog pages and preserves meaningful per-project disk accounting.

Core project mutations remain synchronous TypeScript transformations. The
native adapter applies them to a loaded snapshot and saves with exact revision
CAS. A conflict reloads canonical state and may re-run the transformation up to
a fixed bound, so the portable `ProjectStoreMutation` contract requires
deterministic, side-effect-free callbacks. No-op mutations neither save nor
publish a revision. Immediate cross-window invalidation events are not yet
implemented; the current native product has one WebView.

The Rust service combines a process mutex for catalog state, project-local
SQLite transactions, and an advisory storage lock. The advisory lock prevents
a second application process from observing or replaying a cross-database
commit halfway through. Project removal deliberately retains its opaque
mapping and workspace lifecycle row until `WorkspaceBackend.delete` reserves
the next workspace revision and clears heavy rows. This matches the core's
project-first/workspace-second deletion order and preserves stale-handle and
identifier-reuse semantics. If a save response is indeterminate, the core
reloads canonical project state before deciding whether a provisional
workspace is safe to remove.

`search_files` is a read-only, case-sensitive literal search over a coherent
workspace snapshot. It accepts either a file or directory scope and returns
deterministically ordered, bounded line matches with Unicode-aware positions.
Because it is implemented against the portable workspace contract in
TypeScript, it does not depend on a shell or host Bun process.

`write_file`, exact-match `replace_text`, and `remove_file` use
compare-and-swap VFS mutations.
For inline projects, IndexedDB commits the mutation and an undo-ready
before/after receipt, its applied path revision, and the workspace revision in
one transaction. For OPFS projects, content bytes are immutable
SHA-256-addressed objects written and closed first; one later IndexedDB
transaction atomically publishes the manifest pointer, receipt, clock, and
revision. Pre-registered cleanup tasks make unpublished and superseded objects
recoverable after interruption. All OPFS operations and cleanup share a
separate origin-wide Web Lock so cleanup cannot race a reader or publisher.
The core checkpoints a mutation before execution and after its tool result,
correlating its receipt with the internal tool-call block identifier. If a
worker stops between those checkpoints, reload reconciliation uses the durable
receipt to record truthful success before the remaining stream is marked
interrupted.

The viewer can resolve a receipt by `change_id` and render its exact original
before/after diff, including a deletion as before-to-empty. Revert is a
required atomic workspace operation, not a viewer-composed write/remove
sequence. An unconsumed receipt applies only when both the current bytes and
per-path mutation revision match the generation that created it. Deleted paths
retain a generation tombstone, so delete/recreate/delete ABA cycles cannot make
an old receipt appear current. The same transaction restores the previous
content, removes a created file, or recreates a deleted file; advances the
workspace revision once; and records
`reverted_at_workspace_revision`. A consumed receipt is permanently
idempotent: later retries report `already_reverted` without inspecting or
mutating whatever now occupies the path. Receipts from older storage without a
provable applied revision are inspectable but never revertible.

A project owns one virtual filesystem and zero or more durable sessions.
Switching a project restores its last selected session or its virtual new chat.
Selecting New chat is idempotent and creates no session record. On first send,
the core atomically stores the new session, cleared project draft, selected
model, and staged user timeline entry before starting model transport. The
streaming assistant entry is appended only when Pi starts it. Deleting a
project's final session returns it to virtual new-chat state. Deleting the final
project creates a deterministic empty replacement so the viewer always has an
active project, but an active session is intentionally optional.

## Storage roadmap

`WorkspaceBackend` owns project workspace lifecycle and returns a `Workspace`.
The workspace contract is split into structural `WorkspaceReader`,
`WorkspaceWriter`, and `WorkspaceChangeJournal` capabilities so consumers
depend only on operations they use. Compare-and-swap writes and atomic
file-plus-receipt commits are mandatory semantics, not optional capability
flags. `WorkspaceChangeJournal.revertChange` also has mandatory one-time,
generation-aware semantics across every backend. A project id's first
workspace starts at revision zero; replacements
continue the same sequence so cached content can never mistake a new
incarnation for older data. Deleting an active workspace reserves exactly one
revision for its possible replacement, while repeated idempotent deletion does
not. Each changed write or successful removal increments exactly once, while
unchanged and failed operations do not. Initial seeds form the first
revision-zero baseline. A deleted marker whose revision is missing or invalid
cannot be reconstructed after its files and receipts have been cleared, so a
durable backend must fail closed instead of resetting that project sequence.

Memory, IndexedDB, and OPFS also expose the optional
`WorkspaceFilesSnapshotReader` capability. It returns all files with one
coherent revision, so archive export avoids recursive directory traversal and
per-file metadata reloads. Snapshot cancellation is checked before and after
storage work; IndexedDB aborts its read transaction and OPFS checks between
immutable-object reads.

Backends that can enumerate lifecycle records expose
`WorkspaceOrphanReconciler`. Core startup passes the complete persisted project
set before opening any workspace. The browser backends then delete active
workspaces absent from that set while retaining revision tombstones. This
repairs a process stop between workspace creation and project publication, as
well as a stop between project deletion and workspace cleanup.

- memory: implemented deterministic test backend
- IndexedDB: implemented durable metadata, journal, and fallback content backend
- OPFS: implemented immutable content backend with resumable IndexedDB migration
- native application storage: implemented Rust/SQLite backend behind typed
  MessagePort and Tauri RPC for desktop and mobile
- ZIP: implemented deterministic content-transfer codec, not a live backend

The current workspace format contains UTF-8 text files and infers directories
from paths; empty directories and binary files are intentionally not yet part
of the portable contract. Logical paths are case-sensitive Unicode and preserve
distinct normalization forms. Native backends must use an encoded physical
representation or metadata where a host filesystem cannot preserve that
namespace exactly; their on-disk representation is not a public contract.
Deleted workspace markers retain only the next project-scoped revision so
reusing an identifier cannot move the viewer's cache backwards; file content
and change receipts are still removed.

Native project usage reports three deliberately different measures:
`logical_bytes` for user payload accounting, SQLite `database_bytes`, and total
project-directory `disk_bytes`. A category breakdown separates workspace,
conversation, history, and database overhead bytes. SQLite free pages and WAL
growth mean physical size need not decrease immediately after logical deletion;
future quotas should therefore use logical bytes rather than transient disk
allocation. The typed usage query is not yet exposed through the viewer/core
protocol.

Browser storage version 9 gives each active workspace an explicit
`indexeddb` or `opfs` content owner. Migration never performs filesystem I/O in
an IndexedDB upgrade transaction. Inline content remains authoritative while
each OPFS candidate is copied and recorded; a final IndexedDB transaction
rechecks the incarnation, source revision, and exact path coverage before
flipping ownership. Cleanup of stale inline rows and unreachable OPFS objects
is idempotent and resumes from durable `meta` records. Each incarnation also
persists its baseline revision; a receipt is revertible only when its applied
revision is strictly newer than that baseline. Project-scoped file-path
tombstones retain the exact mutation revision of an absent path and are cleared
atomically when that path is recreated or an ancestor/descendant namespace
mutation makes the missing generation obsolete.

## Workspace archive boundary

`packages/workspace-archive` captures a stable `WorkspaceReader` snapshot and
encodes portable file content. Format v1 has one root manifest,
`researchbox-workspace.json`, followed by payload entries below `workspace/`.
Logical paths determine a stable entry order. The encoder uses ZIP STORE only
and fixed metadata, so the same snapshot produces byte-identical bytes.

The decoder accepts only the exact manifest-declared layout and applies bounded
archive, manifest, file-count, per-file, aggregate-content, path-length, and
path-depth limits before returning content. It rejects unsafe, duplicate, or
colliding paths and unsupported ZIP structures, and verifies ZIP CRC-32,
manifest SHA-256 values, byte sizes, and UTF-8 validity. Archives deliberately
exclude the captured source revision, change receipts, workspace history,
projects, and sessions. Export reports the coherent source revision to its
caller separately, but does not serialize it.

Decoded files are intended for import as a new workspace:
`backend.create(new_project_id, { initial_files: decoded.files })`. Explicit
`initial_files`, including an empty array, replace a backend's configured seed
and form a revision-zero baseline without change receipts. Omitting the field
retains the configured seed. Import never resumes the source revision or
history.

The versioned viewer/core protocol keeps this boundary ZIP-neutral: export
returns a revision-stable JSON snapshot of `{ path, content }` records, and
import sends a validated snapshot when creating a new project. The browser
composition alone owns file picking, downloads, and ZIP bytes. It performs
archive encoding and decoding in a short-lived worker so binary buffers never
enter the core protocol and synchronous codec work never blocks the viewer. A
two-minute worker watchdog covers archive work. User-visible cancellation
covers the import picker, archive worker, and core export capture through a
correlated JSON command. Blob URLs remain alive long enough for WebKit to
consume a download.

Because JSON text crosses the archive worker, viewer, and core realms, the web
composition uses a stricter ceiling than the portable codec: 16 MiB each for
the stored archive and aggregate file content, 8 MiB per file, and 2,048 files.
Validation in the ZIP-free core path computes UTF-8 sizes without retaining a
second encoded copy; ZIP hashing processes fixed-size blocks and a bounded
padding tail.

An import validates and snapshots the new revision-zero workspace before
publishing its project record. A project-store failure deletes that workspace,
and the successful correlated response uses the already-validated snapshot so
a later listing fault cannot turn a durable import into a reported failure.
If the process stops between the two durable commits, startup orphan
reconciliation removes the unpublished workspace.

The browser probes an actual temporary OPFS writable stream before selecting
the hybrid backend, so engines that expose an OPFS root without writable
streams remain on inline IndexedDB. A transient probe failure is surfaced and
may be retried; the runtime never falls back to stale inline content after an
OPFS-owned marker exists. This design provides application/process-crash
consistency. The web platform does not expose a cross-engine fsync or
two-phase-commit guarantee for sudden device power loss.
Backend-specific optional behavior must be added through explicit capability
interfaces rather than runtime checks inside the agent core. All concrete
backends run the same shared conformance suite.
