# @dshrbox/session-runtime

Copy-on-write DSH implementation of rrbox's session-runtime port.

`ResearchBoxCore` continues to own projects, commands, provider selection,
filesystem state, and viewer events. Newly created documents contain only a
DSH runtime reference, draft state, and cached message count; unmarked timeline
documents continue using the legacy runtime. Canonical headers and events live
in the configured DSH persistence backend. The rrbox timeline is rebuilt as an
in-memory viewer projection and is never written beside the DSH log.

The adapter composes the DSH model adapter, read-only workspace tools,
canonical session persistence, and `CoreEvent` projector. Existing
application-owned `AgentPlugin` instances are registered through
`@dshrbox/agent-plugin-adapter`; plugin model completions and summary-review
interactions reuse the same rrbox services as the legacy runtime.

History-tree navigation is deliberately unavailable for DSH sessions until DSH
gains a branch-aware session model. Legacy tool progress updates, inline image
results, and `terminate` remain outside the compatibility surface; unsupported
result semantics fail explicitly.

This package does not activate DSH in the web or native workers. Production
cutover remains an explicit app-runtime change.
