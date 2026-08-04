import { ResearchBoxViewer } from "@researchbox/viewer";
import {
  pythonPluginCatalogEntry,
} from "@researchbox/python-plugin/settings";
import {
  nativeWebSearchPluginCatalogEntry,
} from "@researchbox/web-search-plugin/settings";
import { createNativeCoreTransport } from "../lib/core-transport.ts";
import {
  loadNativeProviderRuntimeConfigurations,
  nativeProviderSettingsAdapter,
} from "../lib/provider-settings.ts";
import type {
  ProviderRuntimeConfiguration,
  ProviderSettingsAdapter,
  ProviderSettingsSnapshot,
} from "@researchbox/provider-settings";
import { publicProviderRuntimeConfiguration } from "@researchbox/provider-settings";
import { useCallback, useEffect, useMemo, useState } from "react";

export function ResearchBoxPage() {
  const [providers, setProviders] = useState<
    ProviderRuntimeConfiguration[] | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadNativeProviderRuntimeConfigurations().then(
      (loaded) => {
        if (active) setProviders(loaded);
      },
      (error: unknown) => {
        if (active) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Provider settings could not be loaded.",
          );
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const synchronizeProviders = useCallback(
    (snapshot: ProviderSettingsSnapshot) => {
      setProviders(
        snapshot.providers
          .filter((provider) => provider.enabled)
          .map(publicProviderRuntimeConfiguration),
      );
      return snapshot;
    },
    [],
  );
  const providerSettingsAdapter = useMemo<ProviderSettingsAdapter>(
    () => ({
      load: nativeProviderSettingsAdapter.load,
      test: nativeProviderSettingsAdapter.test,
      async save(input) {
        return synchronizeProviders(
          await nativeProviderSettingsAdapter.save(input),
        );
      },
      async remove(providerId) {
        return synchronizeProviders(
          await nativeProviderSettingsAdapter.remove(providerId),
        );
      },
    }),
    [synchronizeProviders],
  );
  const createTransport = useCallback(
    () => createNativeCoreTransport(providers ?? []),
    [providers],
  );

  if (loadError) {
    return <main className="native-startup-error">{loadError}</main>;
  }
  if (providers === null) {
    return <main className="native-startup-status">Loading providers…</main>;
  }

  return (
    <ResearchBoxViewer
      createTransport={createTransport}
      providerSettingsAdapter={providerSettingsAdapter}
      plugins={[
        pythonPluginCatalogEntry,
        nativeWebSearchPluginCatalogEntry,
      ]}
    />
  );
}
