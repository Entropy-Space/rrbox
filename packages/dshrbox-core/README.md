# @dshrbox/core

`@dshrbox/core` is the first DSH-backed dshrbox package. It composes the
published DSH session, LLM, system-prompt, tool, agent, and agent-loop services,
then mounts `DshrboxRuntime` as a regular Cordis/DSH plugin.

This package currently owns one live agent. `DshrboxRuntime.subscribe()` emits
the original DSH `SessionEvent` values; there is no dshrbox event projection in
this slice.

`createDshrboxCore()` is the platform-neutral composition helper. Hosts supply
the LLM adapter, route, session identity, optional persona, and optional tool
parallelism. Hosts may also supply Cordis plugin registrations; the helper
installs them after the official DSH services and before creating the dshrbox
agent. Platform constraints belong to the corresponding runtime package.

Browser compatibility and its executable probe live in
`@dshrbox/runtime-browser`.
