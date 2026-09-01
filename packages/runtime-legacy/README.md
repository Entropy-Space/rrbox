# @researchbox/runtime-legacy

Pi-backed compatibility runtime for existing unmarked, timeline-persisted
sessions.

The package implements the neutral legacy runtime provider owned by
`@researchbox/agent-core`. It contains Pi-specific agent execution, model
stream translation, transcript conversion, repair, and legacy plugin types.
Applications install it explicitly at their composition boundary; DSH runtime
packages do not depend on it.

The web and native applications configure DSH for new sessions. This package
preserves old session behavior and storage without migrating or projecting
their canonical timeline documents.
