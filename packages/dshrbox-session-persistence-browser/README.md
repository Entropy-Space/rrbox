# @dshrbox/session-persistence-browser

Durable IndexedDB storage for canonical DSH session headers and append-only
events. The backend shares the existing rrbox database connection but
uses dedicated DSH object stores; it does not persist viewer timelines or
legacy session-history documents.

The implementation provides atomic first materialization and event appends,
source-qualified revisions, seek-capable suffix reads, repair closers, listing,
and idempotent host lifecycle deletion.

Application composition is intentionally outside this package. Web-worker
cutover occurs only after platform persistence adapters can be selected at the
composition root.
