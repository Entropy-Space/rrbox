# ResearchBox native

This Tauri 2 composition root targets macOS, iOS, and Android with one
statically bundled React surface. It mounts the shared `ResearchBoxViewer`,
starts the shared browser core in a Web Worker, and uses a second Worker for
model requests.

The current native runtime uses the browser storage adapters inside the WebView:
project and session state lives in IndexedDB, with workspace content in OPFS
when the WebView supports writable streams and IndexedDB otherwise. This
storage belongs to the Tauri WebView origin. It does not share or automatically
migrate data from the web app at `http://localhost:3000`. Development and
packaged native builds may also use different WebView origins, so their current
browser-backed data should not be treated as one stable application store.

Only the in-process mock provider is enabled. The Rust host currently owns
window lifecycle and packaging but exposes no filesystem or provider commands.
Typed Tauri IPC for application-managed storage and provider networking is the
next platform boundary.

Run the native app during development from the repository root:

```bash
pnpm dev:native
```

Build the static frontend or packaged application:

```bash
pnpm --filter @researchbox/native build
pnpm --filter @researchbox/native tauri build
```

Initialize generated mobile projects only on a development machine with the
relevant platform SDK:

```bash
pnpm --filter @researchbox/native tauri android init
pnpm --filter @researchbox/native tauri ios init
```
