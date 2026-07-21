# ResearchBox

ResearchBox is a browser-native workspace for Pi agents. Its viewer, protocol,
agent runtime, model transport, and virtual filesystem are independent workspace
packages so the same core contracts can support browsers, native shells, and
remote hosts.

## Current vertical slice

- ChatGPT-style responsive conversation viewer
- Real `@earendil-works/pi-agent-core` loop inside a Web Worker
- Versioned, runtime-validated JSON commands and events
- Streaming mock-model service with a real tool-result continuation loop
- In-memory virtual filesystem with `list_files` and `read_file` tools
- Interactive workspace browser and text-file preview

## Repository structure

```text
apps/
  web/                 Vinext application and browser composition root
  mock-server/         Framework-neutral mock model request handler

packages/
  protocol/            Serialized viewer/core contract and validators
  agent-core/          Pi agent orchestration and tools
  viewer/              React conversation and workspace UI
  model-transport/     Model request/stream contract and HTTP adapter
  runtime-browser/     Generic Web Worker host
  vfs/                 Filesystem contract, errors, and adapters

platforms/
  ios/                 Future iOS storage/runtime composition
  desktop/             Future desktop folder/runtime composition
```

The web app is the composition root. Reusable packages do not import Next.js,
Vinext, or application files. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
dependency rules.

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
pnpm lint
pnpm test
```

## Deployment policy

Keep this repository local unless the user explicitly selects and authorizes a
deployment target. Never publish ResearchBox to `chatgpt.site`.

## Next storage milestone

Add an OPFS adapter while retaining the memory adapter as the deterministic
conformance-test backend. ZIP, native-folder, and iOS application-storage
adapters will implement the same `VirtualFileSystem` contract.
