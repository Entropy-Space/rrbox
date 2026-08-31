# @dshrbox/runtime-browser

`@dshrbox/runtime-browser` adapts the platform-neutral `@dshrbox/core`
composition for browser workers.

DSH `0.1.1-rc.2` imports Node built-ins from core packages. Browser builds use
`dshBrowserCompatibilityAliases()` to replace those imports with narrow worker
implementations. The `node:async_hooks` replacement supports one foreground
async chain, so this package fixes tool parallelism to one. The core runtime
also owns one live agent and rejects overlapping runs.

DSH `0.1.1-rc.2` also identifies intrinsic `Object` and `Array` constructors by
their V8-formatted source strings. JavaScriptCore uses multiline native source
formatting, causing ordinary session data and tool schemas to be rejected. The
workspace-level pnpm patches normalize whitespace in that intrinsic check for
`dsh-session` and `dsh-tools`. The executable browser probe simulates the
JavaScriptCore format so the patches can be removed safely after an upstream
release includes the fix.

Multi-agent runs, parallel tool calls, or detached initiator-scoped work require
an upstream browser-safe async-context seam, or a replacement with equivalent
isolation, before those features can be enabled.

`pnpm run build:dshrbox` builds an executable worker probe that verifies DSH
session events, streaming completion, cancellation, and a DSH tool call backed
by the existing VFS through the browser aliases. Probe sources live
under `test/fixtures`; they are not package exports.
