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

test("server-renders the Researchbox application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Researchbox<\/title>/i);
  assert.match(html, /What can I help you build\?/);
  assert.match(html, /Message Researchbox/);
  assert.match(html, /Virtual filesystem/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps the portable core separated from the viewer", async () => {
  const [viewer, worker, core, protocol] = await Promise.all([
    readFile(new URL("../app/ResearchboxApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/core/core.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/core/agent-core.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/protocol.ts", import.meta.url), "utf8"),
  ]);

  assert.match(viewer, /new Worker\(/);
  assert.match(viewer, /createCommand\("bootstrap"/);
  assert.doesNotMatch(viewer, /from "@earendil-works\/pi-agent-core"/);
  assert.match(worker, /parseViewerCommand/);
  assert.match(core, /new Agent\(/);
  assert.match(core, /VirtualFileSystem/);
  assert.match(protocol, /PROTOCOL_VERSION = 1/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
});
