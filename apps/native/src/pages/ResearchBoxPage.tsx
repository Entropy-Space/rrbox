import { ResearchBoxViewer } from "@researchbox/viewer";
import { createNativeCoreTransport } from "../lib/core-transport.ts";

export function ResearchBoxPage() {
  return <ResearchBoxViewer createTransport={createNativeCoreTransport} />;
}
