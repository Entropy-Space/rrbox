# @dshrbox/core

`@dshrbox/core` is the first DSH-backed dshrbox package. It composes the
published DSH session, LLM, system-prompt, tool, agent, and agent-loop services,
then mounts `DshrboxRuntime` as a regular Cordis/DSH plugin.

This package currently owns one live agent. `DshrboxRuntime.subscribe()` emits
the original DSH `SessionEvent` values. Hosts that need the existing rrbox
timeline and viewer event vocabulary can install `@dshrbox/event-projector` as
an optional plugin; core itself keeps the canonical DSH events unchanged.

`createDshrboxCore()` is the platform-neutral composition helper. Hosts supply
the LLM adapter, route, session identity, optional persona, and optional tool
parallelism. Hosts may also supply Cordis plugin registrations; the helper
installs them after the official DSH services and before creating the dshrbox
agent. Platform constraints belong to the corresponding runtime package.

Browser compatibility and its executable probe live in
`@dshrbox/runtime-browser`.

## Skills

Every DSH composition mounts the official `dsh-skill` registry and
`dsh-tool-skill` model adapter. The first application-bundled skill is
`research-brief`; the model can discover and load it through the `skill` tool,
and a user can invoke it directly by including `/research-brief` in a prompt.

This initial slice is read-only and shared by the browser, desktop, iOS, and
Android workers. The definition is compiled into the application. It adds no
filesystem discovery, skill-management UI, Tauri command, or persistence
schema. DSH stores catalog and invocation messages as ordinary session events,
so resume keeps the exact instructions that a prior turn observed.
