# @dshrbox/session-persistence

DSH persistence plugin over a host-supplied `PersistenceBackend`.

The backend stores canonical `SessionHeader` and `SessionEvent` values directly.
Project documents, rrbox timelines, and viewer projections never enter this
storage boundary. DSH's persistence coordinator continues to own batching,
revisions, resume preparation, and crash repair.

`MemoryDshrboxSessionBackend` is provided for tests and explicitly ephemeral
hosts. Browser IndexedDB and project-scoped native SQLite adapters are supplied
by their platform packages and selected only at composition roots.
