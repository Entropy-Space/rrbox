# @dshrbox/session-persistence

Persists canonical DSH session headers and events inside rrbox session
documents. The existing project store remains the durability and concurrency
owner; DSH's persistence coordinator remains the session-log protocol owner.

The state is stored in the document's opaque `runtime_state` field. Documents
without a `dsh` runtime marker are never claimed or migrated by this plugin.
