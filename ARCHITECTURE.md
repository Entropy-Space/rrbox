# ResearchBox architecture

## Runtime flow

```text
apps/web
  ├─ packages/viewer ────────────────┐
  │          │                       │ JSON commands/events
  │          └─ packages/protocol ◄──┤
  │                                  │
  └─ browser/core.worker.ts          │
       ├─ packages/runtime-browser ──┘
       ├─ packages/agent-core
       │    ├─ packages/protocol
       │    ├─ packages/model-transport
       │    ├─ packages/project-store
       │    └─ packages/vfs
       ├─ IndexedDB project/session store
       ├─ IndexedDB workspace backend
       └─ worker model transport
            │ versioned JSON, multiplexed by stream_id
            ▼
          browser/llm.worker.ts
            ├─ packages/runtime-browser LLM host
            ├─ mock NDJSON transport → /api/mock
            └─ OpenAI-compatible SSE transport
                  └─ same-origin bridge → localhost:4141/v1
```

The viewer and core worker exchange only protocol-v7 JSON values. A
`project_id` plus nullable `session_id` scopes the active composer: `null`
identifies that project's single virtual new chat, while incremental run events
always identify a durable session. Filesystem and draft acknowledgements use a
required request identifier, while authoritative snapshots use a monotonic
state revision. Workspace reads also carry a project-scoped
`workspace_revision`; mutation events identify the changed path so the viewer
can refresh its directory and selected file without accepting stale responses.
Together these prevent late work from replacing a newer project, chat, draft,
or file-navigation result. The core and LLM workers use a separate protocol-v4
JSON contract so provider discovery, full conversation requests, provider I/O,
cancellation, and future credentials stay outside the agent runtime. The viewer
never imports Pi,
filesystem implementations, model transports, or either worker runtime.

The LLM worker is an isolation and lifecycle boundary, not a security boundary
against same-origin code. Server-held credentials must remain on the server.

## Dependency rules

1. `apps/web` owns framework integration, worker entry points, and concrete
   adapters.
2. `apps/mock-server` owns mock-model behavior and is mounted by a thin web
   route.
3. `packages/viewer` depends only on React, UI primitives, and the protocol.
4. `packages/agent-core` contains a project/session manager above an optional
   active Pi session runtime and depends only on abstract model, project-store,
   and VFS contracts.
5. `packages/runtime-browser` hosts compatible core and LLM handlers; it does
   not construct ResearchBox, select providers, or import Pi.
6. `packages/model-transport`, `packages/protocol`, `packages/project-store`,
   and `packages/vfs` have no application or framework dependencies.
7. Platform implementations compose these packages; packages never import a
   platform.

## Serialization

All JSON protocol and model-transport fields use `snake_case`. TypeScript type,
function, and class names use the language's normal casing conventions.

The viewer/core and core/LLM protocols evolve independently. `stream_id`
correlates concurrent LLM requests and must not be reused as an agent session
identifier.

## Provider boundary

The LLM worker routes the deterministic mock provider and an OpenAI-compatible
provider whose models are discovered dynamically from `localhost:4141`. It is
started before workspace writer election. A platform-neutral
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
are returned to the elected core. The viewer receives only validated
provider/model summaries.

Provider URLs are application configuration, never viewer input. For the
current local web runtime, two narrow same-origin server routes bridge model
discovery and chat completions to `127.0.0.1:4141`; this avoids relying on CORS
without turning the route into a general proxy. No provider credentials are
stored yet. A future fully browser-only composition can replace the bridge with
a CORS-capable local gateway or an in-browser/Wasm provider adapter without
changing the core/viewer protocol.

## Project and session persistence

The browser runtime attaches its JSON command coordinator immediately. Provider
refresh commands remain available in every tab; workspace commands wait for an
elected core. Writer election first probes conditionally, reports
`waiting_for_writer` rather than silently blocking, then queues an abortable
request for automatic promotion.

The elected browser core owns one IndexedDB database with `meta`, `projects`,
`sessions`, `session_documents`, `project_filesystems`, `files`, and
`file_changes` stores. Catalog writes use a monotonic `state_revision` guard.
Draft-only writes update one project or session document without rewriting the
catalog; this relies on the origin-wide exclusive Web Lock that gives exactly
one core write ownership. Session documents persist the existing-session input
draft and one versioned, ordered timeline. Assistant entries own ordered text,
reasoning, and tool-call blocks; tool results are separate entries linked by
internal block identifiers. That timeline is the viewer state and maps
back into the currently supported text-only user and tool-result Pi surface.
Projects persist their virtual new-chat draft and model selection; durable
sessions persist their own model selection.

`write_file` and exact-match `replace_text` use compare-and-swap VFS writes.
IndexedDB commits the file and an undo-ready before/after receipt in one
transaction. The core checkpoints a mutation before execution and after its
tool result, correlating its receipt with the internal tool-call block
identifier. If a worker stops between those checkpoints, reload reconciliation
uses the durable receipt to record truthful success before the remaining stream
is marked interrupted.

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
flags.

- memory: implemented deterministic test backend
- IndexedDB: implemented durable browser backend
- OPFS: planned large-workspace browser backend
- native folder: planned desktop backend
- iOS application storage: planned native mobile backend
- ZIP: planned deterministic import/export codec, not a live backend

The current workspace format contains UTF-8 text files and infers directories
from paths; empty directories and binary files are intentionally not yet part
of the portable contract. Logical paths are case-sensitive Unicode and preserve
distinct normalization forms. Native backends must use an encoded physical
representation or metadata where a host filesystem cannot preserve that
namespace exactly; their on-disk representation is not a public contract.
Backend-specific optional behavior must be added through explicit capability
interfaces rather than runtime checks inside the agent core. All concrete
backends run the same shared conformance suite.
