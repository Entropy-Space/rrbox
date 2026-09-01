# @dshrbox/session-runtime

Copy-on-write DSH implementation of rrbox's session-runtime port.

`ResearchBoxCore` continues to own projects, commands, provider selection,
filesystem state, and viewer events. Newly created documents contain only a
DSH runtime reference, draft state, and cached message count; unmarked timeline
documents remain passive until their first write creates a DSH child through
copy-on-write migration. `ResearchBoxCore` coordinates the configured runtime
through its neutral port and imports no runtime implementation. Canonical headers and events live in the
configured DSH persistence backend. The rrbox timeline is rebuilt as an
in-memory viewer projection and is never written beside the DSH log.

The runtime receives the application's own model contract. It does
not depend on Pi provider or transcript types.

The runtime composes the DSH model adapter, native workspace tools,
canonical session persistence, live summary-review interaction service, and
`CoreEvent` projector. Additional tools are installed as native Cordis/DSH
plugin registrations on `DshrboxSessionRuntimeProvider`; no compatibility
adapter or runtime translation is involved. On resume, a committed workspace receipt can
recover a mutation whose DSH `tool/result` was interrupted after the VFS
commit; the proven result is written through DSH's canonical repair path before
the session is published.

Python and web research have native DSH entry points. History-tree navigation
remains deliberately unavailable until its DSH-native design lands. Summary
review is available to native plugins as a live service; its transient viewer
events are not appended to the canonical DSH session.

The web and native workers activate this runtime for new sessions, using
durable IndexedDB and project-scoped SQLite events respectively. Existing
unmarked sessions are readable in place and migrate to DSH on continuation.
