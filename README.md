# ResearchBox

ResearchBox is a browser-native workspace for Pi agents. Its viewer, protocol,
agent runtime, model transport, and virtual filesystem are independent workspace
packages so the same core contracts can support browsers, native shells, and
remote hosts.

## Current vertical slice

- ChatGPT-style responsive conversation viewer
- Persistent projects, submitted chats, and project/session input drafts
- One virtual new-chat state per project; a session is created on first send
- Real `@earendil-works/pi-agent-core` loop inside a Web Worker
- Dedicated LLM Web Worker for multiplexed model requests and cancellation
- Chat-scoped provider/model picker with a built-in mock and dynamic
  OpenAI-compatible discovery at `localhost:4141`
- Versioned, runtime-validated JSON commands and events
- Streaming mock-model service with a real tool-result continuation loop
- One canonical, ordered timeline that preserves reasoning, assistant text,
  tool calls, tool results, and multi-turn continuations exactly as they stream
- Project-isolated IndexedDB virtual filesystems with `list_files`, `read_file`,
  `write_file`, and exact-match `replace_text` tools
- Atomic file-change receipts with line statistics, live workspace refresh, and
  reload recovery when a write commits before its transcript checkpoint
- Versioned timeline checkpoints that restore the supported text and tool
  surface back into Pi messages after reload
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
  runtime-browser/     Core and LLM Web Worker hosts and transports
  vfs/                 Filesystem contract, errors, and adapters
  project-store/       Project/session records and persistence contract

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

The OpenAI-compatible provider expects `GET /v1/models` and streaming
`POST /v1/chat/completions` on `http://127.0.0.1:4141`. The local web server
exposes only those two calls through same-origin routes because the browser
cannot assume the gateway enables CORS. The mock provider remains available
when the local gateway is stopped. Set `RESEARCHBOX_LOCAL_OPENAI_BASE_URL` to
override the local base URL during development.

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## Deployment policy

Keep this repository local unless the user explicitly selects and authorizes a
deployment target. Never publish ResearchBox to `chatgpt.site`.

## Storage

The browser composition stores project metadata, drafts, normalized session
timelines, project files, and undo-ready file-change receipts in one versioned
IndexedDB database. A new chat remains project-scoped draft state until its
first prompt; its selected model, staged user timeline entry, session, and
cleared project draft commit atomically before model transport starts. Existing
chats retain their own model selection. File mutations use compare-and-swap
writes; the file and its receipt share one IndexedDB transaction.

Provider discovery starts independently from workspace ownership. A browser
runtime coordinator exposes provider catalog snapshots immediately, routes
catalog refreshes without waiting for IndexedDB, and creates the stateful core
only after acquiring one origin-wide Web Lock. A contending tab reports that it
is waiting and is promoted automatically when the active writer closes. Only
the elected core can persist a model selection or start inference.

The memory project store and filesystem provider remain deterministic test
backends. ZIP import/export, native folders, iOS application storage, and an
optional OPFS adapter can implement the same portable contracts.
