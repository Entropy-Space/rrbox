"use client";

import { WorkerCoreTransport } from "@researchbox/runtime-browser";
import { ResearchBoxViewer } from "@researchbox/viewer";
import { BrowserWorkspaceTransferAdapter } from "../browser/workspace-transfer.ts";

const workspaceTransferAdapter = new BrowserWorkspaceTransferAdapter();

function createTransport(): WorkerCoreTransport {
  return new WorkerCoreTransport(
    new Worker(new URL("../browser/core.worker.ts", import.meta.url), {
      type: "module",
      name: "researchbox-core",
    }),
  );
}

export default function ResearchBoxApp() {
  return (
    <ResearchBoxViewer
      createTransport={createTransport}
      workspaceTransferAdapter={workspaceTransferAdapter}
    />
  );
}
