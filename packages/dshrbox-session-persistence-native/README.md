# @dshrbox/session-persistence-native

Project-scoped SQLite persistence for canonical DSH `SessionHeader` and
`SessionEvent` values over the existing native storage RPC boundary.

Each backend instance is bound to one rrbox project. Session headers and events
live in that project's database, append batches commit atomically, suffix reads
seek by event sequence, and revisions are qualified by a durable storage ID.

This package supplies persistence only. The native application composition root
binds one backend instance per project and installs it through the DSH session
runtime provider.
