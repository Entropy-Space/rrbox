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
       │    └─ packages/vfs
       ├─ memory VFS adapter
       └─ worker model transport
            │ versioned JSON, multiplexed by stream_id
            ▼
          browser/llm.worker.ts
            ├─ packages/runtime-browser LLM host
            └─ HTTP model transport → /api/mock
```

The viewer and core worker exchange only viewer-protocol values. The core and
LLM workers use a separate versioned protocol so provider I/O, cancellation,
and future credentials stay outside the agent runtime. The viewer never imports
Pi, filesystem implementations, model transports, or either worker runtime.

The LLM worker is an isolation and lifecycle boundary, not a security boundary
against same-origin code. Server-held credentials must remain on the server.

## Dependency rules

1. `apps/web` owns framework integration, worker entry points, and concrete
   adapters.
2. `apps/mock-server` owns mock-model behavior and is mounted by a thin web
   route.
3. `packages/viewer` depends only on React, UI primitives, and the protocol.
4. `packages/agent-core` depends on Pi plus abstract model and VFS contracts.
5. `packages/runtime-browser` hosts compatible core and LLM handlers; it does
   not construct ResearchBox, select providers, or import Pi.
6. `packages/model-transport`, `packages/protocol`, and `packages/vfs` have no
   application or framework dependencies.
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
provider support. Before adding providers, `ModelRequest` must grow beyond its
current mock-oriented prompt/tool-result shape to preserve complete Pi context,
tool schemas, model selection, options, and usage.

## Storage roadmap

Every storage backend implements `VirtualFileSystem`:

- memory: implemented, deterministic test backend
- OPFS/IndexedDB: next browser persistence backend
- ZIP: portable import/export backend
- native folder: desktop backend
- iOS application storage: native mobile backend

Backend-specific capabilities must be added through explicit interfaces rather
than runtime checks inside the agent core.
