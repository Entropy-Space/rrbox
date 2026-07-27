import { readNativeShellStatus } from "../lib/tauri.ts";

export function NativeShellPage() {
  const status = readNativeShellStatus();

  return (
    <main className="native-shell">
      <section className="native-shell-card" aria-labelledby="native-title">
        <header className="native-shell-header">
          <span className="native-brand-mark" aria-hidden={true}>
            R
          </span>
          <span className="native-brand-name">ResearchBox</span>
          <span className="native-shell-badge">
            {status.is_native_host ? "Native host ready" : "Web preview"}
          </span>
        </header>

        <div className="native-shell-copy">
          <p className="native-eyebrow">Shared application shell</p>
          <h1 id="native-title">ResearchBox is preparing for native runtimes.</h1>
          <p>
            The macOS, iOS, and Android application now have one Tauri 2
            composition root. The existing React viewer and TypeScript agent
            core remain the shared product surface.
          </p>
        </div>

        <dl className="native-boundaries">
          <div>
            <dt>Shared</dt>
            <dd>Viewer, protocol, agent core, tools, and archive format</dd>
          </div>
          <div>
            <dt>Native</dt>
            <dd>App storage, provider networking, lifecycle, and file dialogs</dd>
          </div>
          <div>
            <dt>Next boundary</dt>
            <dd>Worker → window → typed Tauri IPC → Rust</dd>
          </div>
        </dl>

        <footer className="native-shell-footer">
          <span className="native-status-dot" aria-hidden={true} />
          Bridge phase pending · no project data has been migrated
        </footer>
      </section>
    </main>
  );
}
