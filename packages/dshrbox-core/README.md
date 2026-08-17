# @dshrbox/core

`@dshrbox/core` is the first DSH-backed dshrbox package. It composes the
published DSH session, LLM, system-prompt, tool, agent, and agent-loop services,
then mounts `DshrboxRuntime` as a regular Cordis/DSH plugin.

This package currently owns one live agent. `DshrboxRuntime.subscribe()` emits
the original DSH `SessionEvent` values; there is no dshrbox event projection in
this slice.

## Browser-worker boundary

DSH `0.1.0-rc.6` imports Node built-ins from its core packages. The worker build
uses `dshBrowserCompatibilityAliases()` for the small portable substitutions.
The `node:async_hooks` substitution supports only one foreground async chain,
so the runtime rejects overlapping turns and configures tool execution with
`maxParallelToolCalls: 1`.

Multi-agent runs, parallel tool calls, or detached initiator-scoped work require
an upstream browser-safe async-context seam (or a replacement with equivalent
isolation) before those features can be enabled.

## Probe

`pnpm run build:dshrbox` produces a browser-targeted worker bundle. The probe
uses a fake streaming `LlmAdapter` to verify the official DSH loop, raw session
events, successful completion, and cancellation without changing either v1 app
composition root.
