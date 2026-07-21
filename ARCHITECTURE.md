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
       ├─ IndexedDB project VFS provider
       └─ worker model transport
            │ versioned JSON, multiplexed by stream_id
            ▼
          browser/llm.worker.ts
            ├─ packages/runtime-browser LLM host
            └─ HTTP model transport → /api/mock
```

The viewer and core worker exchange only protocol-v3 JSON values. A
`project_id` plus nullable `session_id` scopes the active composer: `null`
identifies that project's single virtual new chat, while incremental run events
always identify a durable session. Filesystem and draft acknowledgements use a
required request identifier, while authoritative snapshots use a monotonic
state revision. Together these prevent late work from replacing a newer
project, chat, draft, or file-navigation result. The core and LLM workers use a
separate versioned protocol so provider I/O, cancellation, and future
credentials stay outside the agent runtime. The viewer never imports Pi,
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

The LLM worker currently owns only the deterministic mock HTTP transport. This
split moves model I/O out of the core worker but does not yet constitute real
provider support. Pi transcripts are restored into the session runtime, but the
mock-oriented `ModelRequest` currently forwards only the latest turn and tool
results. Before adding providers, it must grow to preserve complete Pi context,
tool schemas, model selection, options, and usage.

## Project and session persistence

The browser core worker owns one IndexedDB database with `meta`, `projects`,
`sessions`, `session_documents`, `project_filesystems`, and `files` stores.
Catalog writes use a monotonic `state_revision` guard. Draft-only writes update
one project or session document without rewriting the catalog; this relies on
the origin-wide exclusive Web Lock that gives one browser core write ownership
while another tab waits. Session documents persist the existing-session input
draft, viewer messages, and a versioned snake-case codec of the canonical Pi
transcript, including tool calls and results. Projects persist their virtual
new-chat draft. Incomplete streams are recovered as interrupted only after the
prior writer has released its lease.

A project owns one virtual filesystem and zero or more durable sessions.
Switching a project restores its last selected session or its virtual new chat.
Selecting New chat is idempotent and creates no session record. On first send,
the core atomically stores the new session, cleared project draft, staged user
and assistant messages, and canonical Pi user message before starting model
transport. Deleting a project's final session returns it to virtual new-chat
state. Deleting the final project creates a deterministic empty replacement so
the viewer always has an active project, but an active session is intentionally
optional.

## Storage roadmap

Every storage backend implements `VirtualFileSystem`:

- memory: implemented, deterministic test backend
- IndexedDB: implemented browser persistence backend
- OPFS: optional large-workspace browser backend
- ZIP: portable import/export backend
- native folder: desktop backend
- iOS application storage: native mobile backend

Backend-specific capabilities must be added through explicit interfaces rather
than runtime checks inside the agent core.
