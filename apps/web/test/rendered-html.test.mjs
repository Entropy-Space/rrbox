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
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /Researchb[o]x/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps package boundaries explicit", async () => {
  const [
    app,
    viewer,
    session,
    coreWorker,
    llmWorker,
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
      readFile(new URL("../browser/core.worker.ts", import.meta.url), "utf8"),
      readFile(new URL("../browser/llm.worker.ts", import.meta.url), "utf8"),
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
  assert.doesNotMatch(viewer, /new Worker\(/);
  assert.match(session, /createCommand\("bootstrap"/);
  assert.match(session, /parseCoreEvent/);
  assert.doesNotMatch(viewer, /from "@earendil-works\/pi-agent-core"/);
  assert.match(coreWorker, /new Worker\(new URL\("\.\/llm\.worker\.ts"/);
  assert.match(coreWorker, /WorkerModelTransport/);
  assert.match(coreWorker, /attachWorkerHost/);
  assert.match(coreWorker, /new ResearchBoxCore/);
  assert.match(coreWorker, /IndexedDbProjectStore/);
  assert.doesNotMatch(coreWorker, /HttpNdjsonModelTransport/);
  assert.match(llmWorker, /attachLlmWorkerHost/);
  assert.match(llmWorker, /HttpNdjsonModelTransport/);
  assert.match(core, /ProjectStore/);
  assert.match(core, /ProjectFileSystemProvider/);
  assert.match(runtime, /new Agent\(/);
  assert.match(runtime, /VirtualFileSystem/);
  assert.match(protocol, /PROTOCOL_VERSION = 3/);

  await assert.rejects(
    access(new URL("../.openai/hosting.json", import.meta.url)),
  );
});
