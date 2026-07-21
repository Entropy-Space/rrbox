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
       ├─ HTTP model transport → /api/mock
       └─ memory VFS adapter
```

The viewer and worker exchange only protocol values. The viewer never imports
Pi, filesystem implementations, model transports, or the worker runtime.

## Dependency rules

1. `apps/web` owns framework integration and selects concrete adapters.
2. `apps/mock-server` owns mock-model behavior and is mounted by a thin web
   route.
3. `packages/viewer` depends only on React, UI primitives, and the protocol.
4. `packages/agent-core` depends on Pi plus abstract model and VFS contracts.
5. `packages/runtime-browser` hosts any compatible command handler; it does not
   construct ResearchBox or import Pi.
6. `packages/model-transport`, `packages/protocol`, and `packages/vfs` have no
   application or framework dependencies.
7. Platform implementations compose these packages; packages never import a
   platform.

## Serialization

All JSON protocol and model-transport fields use `snake_case`. TypeScript type,
function, and class names use the language's normal casing conventions.

## Storage roadmap

Every storage backend implements `VirtualFileSystem`:

- memory: implemented, deterministic test backend
- OPFS/IndexedDB: next browser persistence backend
- ZIP: portable import/export backend
- native folder: desktop backend
- iOS application storage: native mobile backend

Backend-specific capabilities must be added through explicit interfaces rather
than runtime checks inside the agent core.
