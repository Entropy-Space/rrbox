"use client";

import { ResearchBoxViewer } from "@researchbox/viewer";

function createWorker(): Worker {
  return new Worker(new URL("../browser/core.worker.ts", import.meta.url), {
    type: "module",
    name: "researchbox-core",
  });
}

export default function ResearchBoxApp() {
  return <ResearchBoxViewer createWorker={createWorker} />;
}
