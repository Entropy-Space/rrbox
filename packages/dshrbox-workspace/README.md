# @dshrbox/workspace

`@dshrbox/workspace` is the read-only DSH plugin for an existing workspace.
It registers `list_files`, `search_files`, and `read_file` with the DSH tool
runtime while preserving `@researchbox/vfs` as the owner of filesystem
semantics.

The plugin accepts an existing `WorkspaceReader`; it does not create or persist
a workspace. Mutation tools are intentionally deferred until their receipt
metadata no longer depends on the v1 timeline representation.
