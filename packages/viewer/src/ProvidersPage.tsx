"use client";

import type { ProviderSettingsAdapter, ProviderSettingsSnapshot } from "@researchbox/provider-settings";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { OpenAICompatibleSettingsPanel } from "./OpenAICompatibleSettingsPanel.tsx";
import { ToknSettingsPanel } from "./ToknSettingsPanel.tsx";
import {
  PROVIDER_SETTINGS_TABS,
  providerSettingsTabForKey,
  type ProviderSettingsTab,
} from "./provider-settings-tabs.ts";

export function ProvidersPage({
  adapter,
  saveBlockedReason,
  onClose,
  onChanged,
}: {
  adapter: ProviderSettingsAdapter;
  saveBlockedReason: string | null;
  onClose(): void;
  onChanged(snapshot: ProviderSettingsSnapshot): void;
}) {
  const id = useId();
  const tabRefs = useRef<Partial<Record<ProviderSettingsTab, HTMLButtonElement | null>>>({});
  const [selectedTab, setSelectedTab] = useState<ProviderSettingsTab>(
    adapter.tokn ? "tokn" : "openai_compatible",
  );
  const [snapshot, setSnapshot] = useState<ProviderSettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hasTokn = adapter.tokn !== undefined;
  const activeTab = hasTokn ? selectedTab : "openai_compatible";

  useEffect(() => {
    let active = true;
    void adapter.load().then(
      (loaded) => {
        if (active) setSnapshot(loaded);
      },
      (error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [adapter]);

  function acceptSnapshot(next: ProviderSettingsSnapshot) {
    setSnapshot(next);
    onChanged(next);
  }

  return (
    <section className="providers-page" aria-labelledby="providers-page-title">
      <header className="providers-page-header">
        <div>
          <span className="providers-page-eyebrow">Model connections</span>
          <h1 id="providers-page-title">Providers</h1>
          <p>
            Connect model providers. Credentials are stored unencrypted on this
            device and never shown again.
          </p>
        </div>
        <button className="icon-button" type="button" aria-label="Close providers" onClick={onClose}>
          <X size={19} />
        </button>
      </header>

      <div className="provider-content">
        {hasTokn && (
          <div className="provider-tabs" role="tablist" aria-label="Provider configuration">
            {PROVIDER_SETTINGS_TABS.map((tab) => (
              <button
                key={tab.id}
                ref={(element) => { tabRefs.current[tab.id] = element; }}
                id={`${id}-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`${id}-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setSelectedTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.altKey || event.ctrlKey || event.metaKey) return;
                  const next = providerSettingsTabForKey(tab.id, event.key);
                  if (next === null) return;
                  event.preventDefault();
                  setSelectedTab(next);
                  tabRefs.current[next]?.focus();
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {loadError && <div className="provider-page-message error" role="alert">{loadError}</div>}
        {!loadError && snapshot === null && (
          <div className="provider-page-message" role="status">Loading provider settings…</div>
        )}

        {/* Hide rather than unmount: switching views must not discard either draft. */}
        {hasTokn && (
          <div
            className="provider-settings-panel"
            id={`${id}-panel-tokn`}
            role="tabpanel"
            aria-labelledby={`${id}-tab-tokn`}
            tabIndex={0}
            hidden={activeTab !== "tokn"}
          >
            {snapshot?.embedded_tokn && adapter.tokn ? (
              <ToknSettingsPanel
                snapshot={snapshot.embedded_tokn}
                adapter={adapter.tokn}
                saveBlockedReason={saveBlockedReason}
                onSaved={acceptSnapshot}
              />
            ) : snapshot !== null ? (
              <div className="provider-page-message" role="status">
                Embedded Tokn settings are unavailable on this device.
              </div>
            ) : null}
          </div>
        )}

        <div
          className="provider-settings-panel"
          id={`${id}-panel-openai_compatible`}
          role={hasTokn ? "tabpanel" : undefined}
          aria-labelledby={hasTokn ? `${id}-tab-openai_compatible` : undefined}
          tabIndex={hasTokn ? 0 : undefined}
          hidden={activeTab !== "openai_compatible"}
        >
          {snapshot && (
            <OpenAICompatibleSettingsPanel
              snapshot={snapshot}
              adapter={adapter}
              saveBlockedReason={saveBlockedReason}
              onSaved={acceptSnapshot}
            />
          )}
        </div>
      </div>
    </section>
  );
}
