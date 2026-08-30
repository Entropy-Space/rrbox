# @dshrbox/workspace

`@dshrbox/workspace` is the native DSH plugin for an existing rrbox
workspace. It registers `list_files`, `search_files`, `read_file`,
`write_file`, `replace_text`, and `remove_file` with the DSH tool runtime while
preserving `@researchbox/vfs` as the owner of filesystem semantics.

The plugin accepts an existing mutable `Workspace`; it does not create or
persist one. Mutations keep VFS compare-and-swap, revision, and journal
behavior. Each journal record is tied to the durable DSH `tool/call` event and
the same stable tool-call block identity used by the CoreEvent projector.

Successful changes expose `file_change` and `workspace_revision` as DSH tool
result metadata. `@dshrbox/event-projector` uses that metadata to project the
existing timeline receipt and `workspace_changed` event consumed by the
viewer.
