"use client";

import { WorkerCoreTransport } from "@researchbox/runtime-browser";
import {
  loadPluginSettings,
  ResearchBoxViewer,
} from "@researchbox/viewer";
import {
  pythonPluginCatalogEntry,
  resolvePythonPluginRuntimeConfiguration,
} from "@researchbox/python-plugin/settings";
import {
  resolveWebSearchPluginRuntimeConfiguration,
  webSearchPluginCatalogEntry,
} from "@researchbox/web-search-plugin/settings";
import { BrowserWorkspaceTransferAdapter } from "../browser/workspace-transfer.ts";
import {
  WEB_CORE_WORKER_PROTOCOL_VERSION,
  type WebCoreWorkerInitializeMessage,
} from "../browser/core-worker-initialization.ts";

const workspaceTransferAdapter = new BrowserWorkspaceTransferAdapter();

function createTransport(): WorkerCoreTransport {
  const worker = new Worker(new URL(
    "../browser/core.worker.ts",
    import.meta.url,
  ), {
      type: "module",
      name: "researchbox-core",
  });
  const transport = new WorkerCoreTransport(worker);
  const settings = loadPluginSettings();
  const initialization: WebCoreWorkerInitializeMessage = {
    protocol_version: WEB_CORE_WORKER_PROTOCOL_VERSION,
    kind: "web_core_initialize",
    python_plugin: resolvePythonPluginRuntimeConfiguration(
      settings.plugins.python,
    ),
    web_search_plugin: resolveWebSearchPluginRuntimeConfiguration(
      settings.plugins["web-search"],
    ),
  };
  try {
    worker.postMessage(initialization);
  } catch (error) {
    transport.close();
    throw error;
  }
  return transport;
}

export default function ResearchBoxApp() {
  return (
    <ResearchBoxViewer
      createTransport={createTransport}
      plugins={[
        pythonPluginCatalogEntry,
        webSearchPluginCatalogEntry,
      ]}
      workspaceTransferAdapter={workspaceTransferAdapter}
    />
  );
}
