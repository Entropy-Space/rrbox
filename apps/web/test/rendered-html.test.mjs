import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the ResearchBox application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>ResearchBox<\/title>/);
  assert.match(html, /What can I help you build\?/);
  assert.match(html, /Message ResearchBox/);
  assert.match(html, /Virtual filesystem/);
  assert.match(html, /Search the workspace/);
  assert.match(html, /Search chats/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-label="Search saved chats"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-keyshortcuts="Control\+K Meta\+K"/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /Researchb[o]x/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("loads viewer styling through the viewer package export", async () => {
  const [layout, globals, viewerStyles, viewerManifestSource] =
    await Promise.all([
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      readFile(
        new URL("../../../packages/viewer/src/styles.css", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../packages/viewer/package.json", import.meta.url),
        "utf8",
      ),
    ]);
  const viewerManifest = JSON.parse(viewerManifestSource);

  assert.match(layout, /import "@researchbox\/viewer\/styles\.css"/);
  assert.equal(viewerManifest.exports["./styles.css"], "./src/styles.css");
  assert.match(globals, /@import "tailwindcss"/);
  assert.doesNotMatch(globals, /\.app-shell\s*\{/);
  assert.match(viewerStyles, /\.app-shell\s*\{/);
  assert.doesNotMatch(viewerStyles, /@import "tailwindcss"/);
});

test("keeps package boundaries explicit", async () => {
  const [
    app,
    viewer,
    session,
    workerTransport,
    coreWorker,
    sharedCoreWorker,
    llmWorker,
    archiveWorker,
    workspaceTransfer,
    core,
    runtime,
    protocol,
  ] =
    await Promise.all([
      readFile(new URL("../app/ResearchBoxApp.tsx", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../../packages/viewer/src/ResearchBoxViewer.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../../packages/viewer/src/use-agent-session.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../../packages/runtime-browser/src/worker-core-transport.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(new URL("../browser/core.worker.ts", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../../packages/app-runtime-browser/src/researchbox-core-worker.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(new URL("../browser/llm.worker.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../browser/archive.worker.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../browser/workspace-transfer.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../../../packages/agent-core/src/researchbox-core.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../../packages/agent-core/src/session-runtime.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../../../packages/protocol/src/index.ts", import.meta.url),
        "utf8",
      ),
    ]);

  assert.match(app, /new Worker\(new URL\(/);
  assert.match(app, /WorkerCoreTransport/);
  assert.match(app, /createTransport=\{createTransport\}/);
  assert.match(app, /workspaceTransferAdapter/);
  assert.doesNotMatch(viewer, /new Worker\(/);
  assert.doesNotMatch(viewer, /\bWorker\b/);
  assert.doesNotMatch(session, /\bWorker\b|postMessage/);
  assert.match(session, /CoreTransportFactory/);
  assert.match(session, /transport\.send\(createCommand\("bootstrap"/);
  assert.match(session, /createCommand\("bootstrap"/);
  assert.match(workerTransport, /parseCoreEvent/);
  assert.match(viewer, /<details className="reasoning-block">/);
  assert.doesNotMatch(
    viewer,
    /<details className="reasoning-block"[^>]*\sopen(?:=|\s|>)/,
  );
  assert.match(viewer, /role="status"/);
  assert.match(viewer, /aria-busy=\{status === "running"\}/);
  assert.doesNotMatch(viewer, /from "@earendil-works\/pi-agent-core"/);
  assert.match(coreWorker, /new Worker\(new URL\("\.\/llm\.worker\.ts"/);
  assert.match(coreWorker, /startResearchBoxCoreWorker/);
  assert.match(sharedCoreWorker, /WorkerModelTransport/);
  assert.match(sharedCoreWorker, /startBrowserRuntime/);
  assert.match(sharedCoreWorker, /new ResearchBoxCore/);
  assert.match(sharedCoreWorker, /IndexedDbProjectStore/);
  assert.match(sharedCoreWorker, /BrowserWorkspaceBackend/);
  assert.doesNotMatch(coreWorker, /new ResearchBoxCore/);
  assert.doesNotMatch(coreWorker, /HttpNdjsonModelTransport/);
  assert.match(llmWorker, /attachLlmWorkerHost/);
  assert.match(llmWorker, /HttpNdjsonModelTransport/);
  assert.match(llmWorker, /OpenAiCompatibleModelTransport/);
  assert.match(
    workspaceTransfer,
    /new Worker\(new URL\("\.\/archive\.worker\.ts"/,
  );
  assert.match(archiveWorker, /encodeWorkspaceArchive/);
  assert.match(archiveWorker, /decodeWorkspaceArchive/);
  assert.doesNotMatch(
    `${coreWorker}\n${sharedCoreWorker}`,
    /archive_bytes|workspace-archive/,
  );
  assert.match(core, /ProjectStore/);
  assert.match(core, /WorkspaceBackend/);
  assert.match(runtime, /new Agent\(/);
  assert.match(runtime, /WorkspaceController/);
  assert.match(protocol, /PROTOCOL_VERSION = 19/);

  await assert.rejects(
    access(new URL("../.openai/hosting.json", import.meta.url)),
  );
});

test("keeps assistant Markdown rendering inert and source preserving", async () => {
  const [component, helpers, viewer] = await Promise.all([
    readFile(
      new URL(
        "../../../packages/viewer/src/MarkdownContent.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../../../packages/viewer/src/markdown.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../packages/viewer/src/ResearchBoxViewer.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const markdownSources = `${component}\n${helpers}`;

  assert.match(viewer, /<MarkdownContent/);
  assert.match(component, /skipHtml=\{true\}/);
  assert.match(component, /remarkPlugins=\{MARKDOWN_PLUGINS\}/);
  assert.match(component, /className="markdown-image-placeholder"/);
  assert.match(component, /rel=\{isExternal \? "noopener noreferrer"/);
  assert.match(helpers, /linkMode: "text-only"/);
  assert.match(helpers, /inlineKatex: false/);
  assert.match(helpers, /katex: false/);
  assert.doesNotMatch(
    markdownSources,
    /dangerouslySetInnerHTML|rehypeRaw|rehype-raw/,
  );
});

test("gives readers control of conversation scrolling during streaming", async () => {
  const [viewer, controller, helpers, styles] = await Promise.all([
    readFile(
      new URL(
        "../../../packages/viewer/src/ResearchBoxViewer.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../packages/viewer/src/use-conversation-scroll.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../../packages/viewer/src/conversation-scroll.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../../../packages/viewer/src/styles.css", import.meta.url),
      "utf8",
    ),
  ]);
  const scrollSources = `${viewer}\n${controller}`;

  assert.match(viewer, /id="researchbox-message-list"/);
  assert.match(viewer, /role="log"/);
  assert.match(viewer, /aria-label="Conversation messages"/);
  assert.match(viewer, /tabIndex=\{0\}/);
  assert.match(viewer, /onScroll=\{handleConversationScroll\}/);
  assert.match(viewer, /onKeyDown=\{handleConversationKeyDown\}/);
  assert.match(
    viewer,
    /onClickCapture=\{handleConversationClickCapture\}/,
  );
  assert.match(viewer, /aria-label="Jump to latest message"/);
  assert.match(viewer, /aria-controls="researchbox-message-list"/);
  assert.match(controller, /"timeline_changed"/);
  assert.match(controller, /"conversation_changed"/);
  assert.match(controller, /"layout_change_requested"/);
  assert.match(controller, /new ResizeObserver\(remeasure\)/);
  assert.match(controller, /focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(
    scrollSources,
    /behavior:\s*coreState\.is_running\s*\?\s*"smooth"/,
  );
  assert.match(helpers, /CONVERSATION_END_THRESHOLD_PX = 64/);
  assert.match(helpers, /conversationGeneration !==/);
  assert.match(styles, /\.jump-to-latest\s*\{/);
  assert.match(styles, /\.message-list:focus-visible\s*\{/);
});
