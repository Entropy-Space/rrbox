# `@dshrbox/agent-plugin-adapter`

Copy-on-write compatibility for registering existing rrbox
`AgentPlugin` tools in a DeepSeek Harness runtime.

The adapter keeps the legacy TypeBox schema as the execution-time authority and
projects its model-facing subset into DSH's enforced JSON Schema vocabulary.
Legacy result details are persisted as DSH presentation metadata so the rrbox
event projector can retain viewer summaries.

This bridge intentionally rejects semantics that DSH cannot preserve:

- inline image content, which needs a DSH attachment service
- `terminate`, whose legacy all-results rule differs from DSH's per-result rule

Legacy progress callbacks are not emitted because DSH has no durable
tool-progress session event. Tools still receive cancellation through the DSH
execution signal.
