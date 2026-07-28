import { ResearchBoxViewer } from "@researchbox/viewer";
import {
  pythonPluginCatalogEntry,
} from "@researchbox/python-plugin/settings";
import {
  nativeWebSearchPluginCatalogEntry,
} from "@researchbox/web-search-plugin/settings";
import { createNativeCoreTransport } from "../lib/core-transport.ts";

export function ResearchBoxPage() {
  return (
    <ResearchBoxViewer
      createTransport={createNativeCoreTransport}
      plugins={[
        pythonPluginCatalogEntry,
        nativeWebSearchPluginCatalogEntry,
      ]}
    />
  );
}
