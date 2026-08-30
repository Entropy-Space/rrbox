# Web research

This package owns web search, URL reading, evidence synthesis, and the
interactive summary-review workflow. Provider executors and URL readers remain
application-owned resources; neither plugin surface closes them.

## DSH plugin

Register `DshrboxWebResearch` from `@researchbox/web-search-plugin/dsh` after
the DSH LLM, tools, and `@dshrbox/summary-review` services. It registers native
`web_search` and `open_url` definitions with structured canonical output,
model-facing text rendering, and presentation summaries.

Auxiliary synthesis calls use the provider and model on the executing DSH
agent. A model selected in the summary-review UI overrides that identity for
the requested regeneration. Review state is live and non-durable; the owning
dshrbox session runtime emits the existing viewer `CoreEvent`s.

## Copy-on-write boundary

`web-research-engine.ts` contains runtime-neutral research behavior. The
existing package root keeps the legacy Pi plugin as a thin wrapper until the
application cutover. The DSH entry does not import or translate Pi tool
objects, schemas, events, or model adapters.

DSH currently has no native per-tool progress stream, so the DSH tool result is
published when it settles. The summary-review service continues to provide
live search and synthesis updates while its dialog is open.
