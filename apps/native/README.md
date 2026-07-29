# rrbox native

This Tauri 2 composition root targets macOS, iOS, and Android with one
statically bundled React surface. It mounts the shared `ResearchBoxViewer`,
starts the shared browser core in a Web Worker, and uses a second Worker for
model requests.

The native runtime uses app-private host storage instead of WebView
IndexedDB/OPFS. Its core Worker sends typed requests over a transferred
`MessagePort`; the WebView host brokers them to one async Tauri command, and a
Rust service owns recovery, locking, and SQLite transactions.

The native layout is:

```text
<app-data>/researchbox/
├── catalog.sqlite3
├── projects/
│   └── <opaque-storage-id>/
│       └── project.sqlite3
├── staging/
└── trash/
```

The catalog stores the global project revision, ordering, selection, lifecycle
markers, and the mapping from logical project IDs to opaque directories. Each
project database stores that project's metadata, chats, drafts, workspace
content, revisions, tombstones, and change receipts. A synced staging journal
makes an interrupted cross-database project-state save replayable before its
catalog revision becomes visible. Project-local reads and writes use SQLite
transactions; catalog and lifecycle recovery is protected from a second
process by an advisory storage lock.

The typed storage client can report logical, database, and on-disk usage for
each project with a workspace/conversation/history/overhead breakdown. Usage is
not displayed in the viewer yet.

Existing experimental native IndexedDB/OPFS data remains untouched but is not
migrated automatically. Browser data at `http://localhost:3000` is separate.

The native model worker exposes both the in-process mock provider and an
OpenAI-compatible provider at `http://127.0.0.1:4141/v1`. The WebView cannot
open arbitrary native URLs: a typed `MessagePort` broker permits only
`GET /models` and `POST /chat/completions`, and Rust owns the HTTP connection,
timeouts, response limits, streaming, and cancellation. The existing
TypeScript OpenAI transport remains the only SSE and tool-call parser. If the
local provider is unavailable, only that catalog entry becomes unavailable;
the mock provider remains usable.

On macOS, `127.0.0.1` refers to the same Mac running rrbox. On iOS and
Android it refers to the device or emulator, not the development Mac. A
configurable, authenticated LAN provider endpoint is intentionally deferred
until its network and credential policy is designed.

Run the native app during development from the repository root:

```bash
pnpm dev:native
```

Build the static frontend or packaged application:

```bash
pnpm --filter @researchbox/native build
pnpm --filter @researchbox/native tauri build
```

Validate the Rust storage service:

```bash
cargo test --manifest-path apps/native/src-tauri/Cargo.toml
```

The repository-wide `pnpm test` also enables a non-default test-harness feature
and runs the native SQLite backend through the same 30-case workspace and
durability conformance suites as the browser backends. The line-oriented
harness binary is feature-gated and is not included in normal native builds.

## iOS

The generated Xcode project is committed at `src-tauri/gen/apple`. rrbox
targets iOS 15 and newer on arm64 devices and Apple Silicon simulators. The
project was generated and tested with Xcode 16.3 and XcodeGen 2.45.4. Build
products, the linked Rust library, and per-user Xcode state are ignored by the
generated project.

Install the Apple toolchain once on each development machine:

```bash
xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
```

Tauri's Apple tooling also expects `xcodegen`, `libimobiledevice`, and
CocoaPods on `PATH`. With Homebrew they can be installed with:

```bash
brew install xcodegen libimobiledevice cocoapods
```

Build the debug app for an Apple Silicon simulator or start it interactively:

```bash
pnpm build:native:ios-sim
pnpm dev:native:ios
```

Physical-device and App Store builds require an Apple development team,
certificate, and provisioning profile. Supply the shared team through the
local or CI `APPLE_DEVELOPMENT_TEAM` environment variable; do not commit a
personal team identifier.

Regenerate the checked-in Xcode project only when the Tauri configuration or
mobile project template changes, then review the generated diff:

```bash
pnpm --filter @researchbox/native tauri ios init
```

The Android project remains uninitialized. Initialize it separately on a
machine with the Android SDK:

```bash
pnpm --filter @researchbox/native tauri android init
```
