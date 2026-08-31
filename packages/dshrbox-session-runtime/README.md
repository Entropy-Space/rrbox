# @dshrbox/session-runtime

Copy-on-write DSH implementation of rrbox's session-runtime port.

`ResearchBoxCore` continues to own projects, commands, provider selection,
filesystem state, and viewer events. Newly created documents contain only a
DSH runtime reference, draft state, and cached message count; unmarked timeline
documents continue through an explicit `PiSessionRuntimeProvider`
compatibility lane. `ResearchBoxCore` coordinates both providers but imports
neither runtime implementation. Canonical headers and events live in the
configured DSH persistence backend. The rrbox timeline is rebuilt as an
in-memory viewer projection and is never written beside the DSH log.

The runtime composes the DSH model adapter, native workspace tools,
canonical session persistence, live summary-review interaction service, and
`CoreEvent` projector. Additional tools are installed as native Cordis/DSH
plugin registrations on
`DshrboxSessionRuntimeProvider`; legacy `AgentPlugin` values are rejected and
never translated at runtime. On resume, a committed workspace receipt can
recover a mutation whose DSH `tool/result` was interrupted after the VFS
commit; the proven result is written through DSH's canonical repair path before
the session is published.

Python and web research have native DSH entry points. History-tree navigation
remains deliberately unavailable until its DSH-native design lands. Summary
review is available to native plugins as a live service; its transient viewer
events are not appended to the canonical DSH session.

The web and native workers activate this runtime for new sessions, using
durable IndexedDB and project-scoped SQLite events respectively. Existing
unmarked sessions remain on the legacy runtime in both applications.
