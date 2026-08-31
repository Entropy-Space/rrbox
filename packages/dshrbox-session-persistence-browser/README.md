# @dshrbox/session-persistence-browser

Durable IndexedDB storage for canonical DSH session headers and append-only
events. The backend shares the existing rrbox database connection but
uses dedicated DSH object stores; it does not persist viewer timelines or
legacy session-history documents.

The implementation provides atomic first materialization and event appends,
source-qualified revisions, seek-capable suffix reads, repair closers, listing,
and idempotent host lifecycle deletion.

Application composition stays outside this package. The web-worker composition
selects this backend for new DSH sessions. Native uses its separate
project-scoped SQLite adapter instead of splitting one project across storage
media.
