# Researchbox

Researchbox is a browser-native workspace for Pi agents. The application keeps
the viewer, agent runtime, model transport, and storage adapters behind explicit
boundaries so the same core can later run in a browser, native shell, or remote
host.

## Current vertical slice

- ChatGPT-style responsive conversation viewer
- Real `@earendil-works/pi-agent-core` agent loop in a Web Worker
- Versioned and runtime-validated JSON command/event protocol
- Mock streaming model endpoint with a real tool-result continuation loop
- In-memory virtual filesystem with `list_files` and `read_file` agent tools
- Interactive workspace browser and text-file preview

The browser worker imports Pi directly. The UI communicates only through
serializable protocol messages and never imports the agent runtime.

## Requirements

- Node.js 22.19 or newer
- pnpm 10.30.3

## Development

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Validation

```bash
pnpm typecheck
pnpm test
```

## Architecture

```text
Viewer ── JSON commands/events ── Web Worker host
                                      │
                                      ▼
                                  Pi Agent core
                                   ╱        ╲
                          Model transport   VFS interface
                                │                │
                          Mock endpoint      Memory adapter
```

The next storage milestone is an OPFS adapter with the memory implementation
retained as the deterministic conformance-test backend. Native folder and iOS
application-storage adapters can then implement the same `VirtualFileSystem`
contract.
