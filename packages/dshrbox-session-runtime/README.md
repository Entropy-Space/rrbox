# @dshrbox/session-runtime

Copy-on-write DSH implementation of rrbox's session-runtime port.

`ResearchBoxCore` continues to own projects, commands, provider selection,
filesystem state, and viewer events. Newly created documents are marked as DSH
sessions; unmarked documents continue using the legacy runtime. The adapter
composes the DSH model adapter, read-only workspace tools, canonical session
persistence, and CoreEvent projector.

This package does not activate DSH in the web or native workers. Production
cutover remains an explicit app-runtime change.
