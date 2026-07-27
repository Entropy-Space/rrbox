import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROTOCOL_VERSION } from "@researchbox/protocol";
import {
  createTransportCloser,
  requestWorkspaceExport,
} from "../src/use-agent-session.ts";
import { WorkspaceTransferRequests } from "../src/workspace-transfer.ts";

test("an import resolves only from its correlated state snapshot", async () => {
  const requests = new WorkspaceTransferRequests();
  let settled = false;
  const completion = requests.beginImport("import-1").then(() => {
    settled = true;
  });

  assert.equal(
    requests.accept(coreEvent("state_snapshot", {}, "another-request")),
    false,
  );
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(requests.size, 1);

  assert.equal(
    requests.accept(coreEvent("state_snapshot", {}, "import-1")),
    true,
  );
  await completion;
  assert.equal(settled, true);
  assert.equal(requests.size, 0);
});

test("an export resolves with the exact correlated snapshot payload", async () => {
  const requests = new WorkspaceTransferRequests();
  const completion = requests.beginExport("export-1");
  const payload = {
    project_id: "project-1",
    project_name: "Research notes",
    workspace_revision: 7,
    files: [
      {
        path: "/README.md",
        content: "# Research notes\n",
      },
    ],
  };

  assert.equal(
    requests.accept(
      coreEvent("workspace_export_snapshot", payload, "export-1"),
    ),
    true,
  );
  assert.deepEqual(await completion, payload);
  assert.equal(requests.size, 0);
});

test("canceling an export rejects promptly and correlates the core cancel", async () => {
  const requests = new WorkspaceTransferRequests();
  const messages = [];
  const controller = new AbortController();
  const completion = requestWorkspaceExport(
    requests,
    { send: (message) => messages.push(message) },
    "project-1",
    controller.signal,
  );
  const exportCommand = messages[0];

  assert.equal(exportCommand.type, "workspace_export");
  assert.equal(requests.size, 1);

  controller.abort();

  await assert.rejects(completion, { name: "AbortError" });
  assert.equal(requests.size, 0);
  assert.equal(messages[1].type, "workspace_export_cancel");
  assert.equal(
    messages[1].payload.target_request_id,
    exportCommand.request_id,
  );
  assert.equal(
    requests.accept(
      coreEvent(
        "error",
        {
          code: "workspace_export_cancelled",
          message: "The workspace export was canceled.",
        },
        exportCommand.request_id,
      ),
    ),
    true,
  );
  assert.equal(
    requests.accept(
      coreEvent(
        "workspace_export_snapshot",
        {
          project_id: "project-1",
          project_name: "Late snapshot",
          workspace_revision: 0,
          files: [],
        },
        exportCommand.request_id,
      ),
    ),
    false,
  );
});

test("a late snapshot for a locally canceled export is consumed", async () => {
  const requests = new WorkspaceTransferRequests();
  const messages = [];
  const controller = new AbortController();
  const completion = requestWorkspaceExport(
    requests,
    { send: (message) => messages.push(message) },
    "project-1",
    controller.signal,
  );
  const exportRequestId = messages[0].request_id;
  controller.abort();
  await assert.rejects(completion, { name: "AbortError" });

  assert.equal(
    requests.accept(
      coreEvent(
        "workspace_export_snapshot",
        {
          project_id: "project-1",
          project_name: "Late snapshot",
          workspace_revision: 0,
          files: [],
        },
        exportRequestId,
      ),
    ),
    true,
  );
});

test("an already-aborted export is rejected without posting commands", async () => {
  const requests = new WorkspaceTransferRequests();
  const messages = [];
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    requestWorkspaceExport(
      requests,
      { send: (message) => messages.push(message) },
      "project-1",
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(requests.size, 0);
  assert.deepEqual(messages, []);
});

test("correlated errors reject one request without disturbing another", async () => {
  const requests = new WorkspaceTransferRequests();
  const importCompletion = requests.beginImport("import-1");
  const exportCompletion = requests.beginExport("export-1");

  assert.equal(
    requests.accept(
      coreEvent(
        "error",
        {
          code: "workspace_export_failed",
          message: "Could not read the workspace.",
        },
        "export-1",
      ),
    ),
    true,
  );
  await assert.rejects(
    exportCompletion,
    /Could not read the workspace/,
  );
  assert.equal(requests.size, 1);

  requests.accept(coreEvent("state_snapshot", {}, "import-1"));
  await importCompletion;
  assert.equal(requests.size, 0);
});

test("transport shutdown rejects every pending transfer", async () => {
  const requests = new WorkspaceTransferRequests();
  const importCompletion = requests.beginImport("import-1");
  const exportCompletion = requests.beginExport("export-1");

  requests.rejectAll(new Error("Worker stopped."));

  await assert.rejects(importCompletion, /Worker stopped/);
  await assert.rejects(exportCompletion, /Worker stopped/);
  assert.equal(requests.size, 0);
});

test("a failed core transport is closed exactly once", () => {
  let closeCount = 0;
  const transport = {
    close() {
      closeCount += 1;
    },
  };
  const closeTransport = createTransportCloser(transport);

  closeTransport();
  closeTransport();

  assert.equal(closeCount, 1);
});

test("duplicate request IDs reject without replacing the original request", async () => {
  const requests = new WorkspaceTransferRequests();
  const original = requests.beginImport("transfer-1");

  await assert.rejects(
    requests.beginExport("transfer-1"),
    /Duplicate workspace transfer request/,
  );
  assert.equal(requests.size, 1);

  requests.accept(coreEvent("state_snapshot", {}, "transfer-1"));
  await original;
});

test("workspace transfer controls are omitted when no adapter is supplied", async () => {
  const [viewer, sidebar] = await Promise.all([
    readFile(
      new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/WorkspaceSidebar.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(
    viewer,
    /onImportProject=\{\s*workspaceTransferAdapter\s*\?\s*importWorkspace\s*:\s*undefined\s*\}/,
  );
  assert.match(
    viewer,
    /onExportProject=\{\s*workspaceTransferAdapter\s*\?\s*exportProjectWorkspace\s*:\s*undefined\s*\}/,
  );
  assert.match(sidebar, /\{onImportProject && \(/);
  assert.match(sidebar, /\{onExportProject && \(/);
});

test("keeps transfer guards separate from project and chat navigation", async () => {
  const [viewer, sidebar] = await Promise.all([
    readFile(
      new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/WorkspaceSidebar.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  const transferGuard = requireSourceBlock(
    viewer,
    "const isWorkspaceTransferDisabled =",
    "const {",
  );
  const sidebarGuard = requireSourceBlock(
    viewer,
    "const isSidebarPending =",
    "useEffect(",
  );

  assert.match(
    transferGuard,
    /pending_fs_list|pending_fs_read|pending_workspace_refresh/,
  );
  assert.match(transferGuard, /refreshingProviderIds/);
  assert.doesNotMatch(
    sidebarGuard,
    /pending_fs_list|pending_fs_read|pending_workspace_refresh|refreshingProviderIds/,
  );
  assert.match(viewer, /isPending=\{isSidebarPending\}/);
  assert.match(
    viewer,
    /isWorkspaceTransferDisabled=\{\s*isWorkspaceTransferDisabled \|\| isWorkspaceTransferPending\s*\}/,
  );
  assert.equal(
    [...sidebar.matchAll(/disabled=\{isWorkspaceTransferDisabled\}/g)].length,
    2,
  );
});

test("workspace transfer status supports cancellation and restores focus", async () => {
  const [viewer, sidebar, transfer, session] = await Promise.all([
    readFile(
      new URL("../src/ResearchBoxViewer.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/WorkspaceSidebar.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/workspace-transfer.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/use-agent-session.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(viewer, /onCancelWorkspaceTransfer=/);
  assert.match(sidebar, /tabIndex=\{-1\}/);
  assert.match(sidebar, /aria-atomic=\{true\}/);
  assert.match(sidebar, /workspaceTransferStatusRef\.current\?\.focus/);
  assert.match(sidebar, /scheduleWorkspaceTransferFocusRestore/);
  assert.match(
    sidebar,
    /if \(workspaceTransferNotice\?\.kind === "progress"\) return;\s+const focusRequest = workspaceTransferReturnFocusRef\.current;\s+if \(focusRequest\) scheduleWorkspaceTransferFocusRestore\(focusRequest\)/,
  );
  assert.match(
    sidebar,
    /if \(isDisabledButton\(target\)\) return;\s+workspaceTransferReturnFocusRef\.current = null/,
  );
  assert.match(sidebar, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(sidebar, />\s*Cancel\s*</);
  assert.match(sidebar, /workspaceTransferNotice\.is_cancellable/);
  assert.match(transfer, /const cancelWorkspaceTransfer = useCallback/);
  assert.match(transfer, /cancellableControllerRef\.current = null/);
  assert.match(transfer, /controller\.abort\(\)/);
  assert.match(transfer, /Workspace transfer canceled\./);
  assert.match(
    transfer,
    /suppressNextImportComposerFocusRef\.current = true;\s+await importProject/,
  );
  assert.match(
    transfer,
    /const consumeImportFocusSuppression = useCallback/,
  );
  assert.match(
    viewer,
    /if \(!coreState\.is_ready \|\| consumeImportFocusSuppression\(\)\) return;/,
  );
  assert.match(
    transfer,
    /message: "Preparing workspace export…",\s*is_cancellable: true/,
  );
  assert.match(
    session,
    /\(!handledWorkspaceTransfer && !handledWorkspaceChange\) \|\|\s*event\.type === "state_snapshot"/,
  );
  assert.match(
    transfer,
    /const importWorkspace = useCallback\(async \(\): Promise<void> =>/,
  );
  assert.match(
    transfer,
    /async \(projectId: string\): Promise<void> =>/,
  );
});

function coreEvent(type, payload, requestId) {
  return {
    protocol_version: PROTOCOL_VERSION,
    event_id: crypto.randomUUID(),
    request_id: requestId,
    type,
    payload,
  };
}

function requireSourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
