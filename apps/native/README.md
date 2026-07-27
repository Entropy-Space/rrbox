# ResearchBox native

This Tauri 2 composition root targets macOS, iOS, and Android with one
statically bundled React surface.

The first checkpoint intentionally contains no storage or provider commands.
Those arrive after the worker-to-window-to-Rust bridge is validated on each
target. Until then, the screen reports the shell boundary without reading or
migrating project data.

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
