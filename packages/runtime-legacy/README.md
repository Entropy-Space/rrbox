# @researchbox/runtime-legacy

Pi-backed compatibility runtime for existing unmarked, timeline-persisted
sessions.

The package implements the neutral legacy runtime provider owned by
`@researchbox/agent-core`. It contains Pi-specific agent execution, model
stream translation, transcript conversion, repair, and legacy plugin types.
Applications install it explicitly at their composition boundary; DSH runtime
packages do not depend on it.

Legacy Pi adapters for the Python and web-research tools also live here. They
depend on the runtime-neutral executors and research engine in their feature
packages; those feature packages expose native DSH plugins and do not import
Pi or this compatibility runtime.

The web and native applications configure DSH for new sessions. This package
preserves old session behavior and storage without migrating or projecting
their canonical timeline documents.
