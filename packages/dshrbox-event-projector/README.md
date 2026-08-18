# `@dshrbox/event-projector`

Projects canonical DSH `SessionEvent` values into rrbox's existing timeline and
viewer `CoreEvent` vocabulary. DSH remains the source of truth; this package is
a deterministic presentation projection, not another session log.

The same projector handles replayed and live events. Timeline, run, entry, and
block identities are derived from durable DSH identities instead of generated
at projection time, so replay converges with the live view.

The default export is a Cordis/DSH plugin. It filters the shared session-event
firehose to one configured session and forwards projected events to the host:

```ts
plugins: [{
  plugin: DshrboxEventProjection,
  config: {
    project_id: projectId,
    session_id: sessionId,
    event_sink: (event) => host.postMessage(event),
  },
}]
```

This slice projects user, assistant, reasoning, tool, terminal, and run-state
events. Filesystem ownership, durable checkpoint writes, history navigation,
and application command handling remain outside the projector. DSH surface
replacement events do not rewrite the human-visible timeline: the original
append-only events remain visible while DSH owns its compacted model surface.
Image blocks fail closed until the existing viewer protocol has an image block.
