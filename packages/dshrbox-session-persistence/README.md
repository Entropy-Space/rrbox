# @dshrbox/session-persistence

DSH persistence plugin over a host-supplied `PersistenceBackend`.

The backend stores canonical `SessionHeader` and `SessionEvent` values directly.
Project documents, rrbox timelines, and viewer projections never enter this
storage boundary. DSH's persistence coordinator continues to own batching,
revisions, resume preparation, and crash repair.

`MemoryDshrboxSessionBackend` is provided for tests and explicitly ephemeral
hosts. Browser and native durability adapters remain composition-root work.
