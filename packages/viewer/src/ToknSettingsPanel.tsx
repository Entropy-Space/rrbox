"use client";

import { useId, useRef, useState } from "react";
import type { ProviderSettingsSnapshot, ToknSettingsAdapter, ToknSettingsSnapshot } from "@researchbox/provider-settings";
import { ToknAdvancedFields } from "./ToknAdvancedFields.tsx";
import { createToknDraft, isToknDraftDirty, toToknSettingsInput } from "./tokn-settings-draft.ts";

type Action = "connect" | "save" | "validate" | "reload";

export function ToknSettingsPanel({ snapshot, adapter, saveBlockedReason, onSaved }: {
  snapshot: ToknSettingsSnapshot;
  adapter: ToknSettingsAdapter;
  saveBlockedReason: string | null;
  onSaved(snapshot: ProviderSettingsSnapshot): void;
}) {
  const id = useId();
  const keyInput = useRef<HTMLInputElement>(null);
  const [providerId, setProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [draft, setDraft] = useState(() => createToknDraft(snapshot));
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const dirty = isToknDraftDirty(draft, snapshot);
  const selected = snapshot.setup_providers.find((provider) => provider.provider_id === providerId);
  const managedAccount = snapshot.accounts.find((account) => account.managed && account.provider_id === providerId);
  const connectBlockedReason = saveBlockedReason ?? (dirty ? "Save or discard Advanced changes before connecting a provider." : null);
  const canConnect = busy === null && connectBlockedReason === null && !!selected?.model_count && apiKey.trim() !== "";

  function chooseProvider(provider: string) {
    setProviderId(provider);
    // Never accidentally submit one provider's key to a different provider.
    setApiKey("");
    setNotice(null);
  }

  async function run(action: Action) {
    if (busy || (action !== "validate" && saveBlockedReason) || (action === "connect" && !canConnect)) return;
    setBusy(action);
    setNotice(null);
    try {
      if (action === "validate") {
        await adapter.validate(toToknSettingsInput(draft));
        setNotice({ error: false, message: "Configuration accepted by Tokn. No connection test or model request was sent." });
        return;
      }
      const next = action === "connect"
        ? await adapter.connect({ provider_id: providerId, api_key: apiKey.trim() })
        : action === "save" ? await adapter.save(toToknSettingsInput(draft)) : await adapter.reload();
      if (next.embedded_tokn) setDraft(createToknDraft(next.embedded_tokn));
      setApiKey("");
      onSaved(next);
      setNotice({ error: false, message: action === "connect"
        ? `${selected?.display_name ?? "Provider"} configured. Models added and Tokn enabled. API key not verified.`
        : action === "save" ? "Saved on this device." : "Embedded Tokn reloaded." });
    } catch (error) {
      setNotice({ error: true, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="provider-editor tokn-settings" aria-labelledby={`${id}-title`}>
      <div className="provider-editor-heading">
        <div><span>Built-in router · {snapshot.enabled ? "Enabled" : "Not enabled"}</span><h2 id={`${id}-title`}>Tokn</h2></div>
      </div>
      <p>Select a provider, paste your API key, and connect. Tokn handles the configuration on this device.</p>

      <form className="tokn-connect-form" onSubmit={(event) => { event.preventDefault(); void run("connect"); }}>
        <fieldset className="provider-editor-fields" disabled={busy !== null}>
          <label className="provider-field provider-field-wide">
            <span>Provider</span>
            <select value={providerId} onChange={(event) => chooseProvider(event.target.value)} required>
              <option value="" disabled>Select a provider</option>
              {snapshot.setup_providers.map((provider) => (
                <option key={provider.provider_id} value={provider.provider_id} disabled={provider.model_count === 0}>
                  {provider.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="provider-field provider-field-wide">
            <span>{managedAccount ? "New API key" : "API key"}</span>
            <input ref={keyInput} type="password" value={apiKey} disabled={!selected} required
              autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={8192}
              placeholder={selected ? `Paste your ${selected.display_name} API key` : "Choose a provider first"}
              onChange={(event) => { setApiKey(event.target.value); setNotice(null); }} />
            <small>{managedAccount
              ? "This replaces the key for your guided-setup account. Other accounts are kept."
              : "Your key is saved only on this device and is never shown again."}</small>
          </label>
        </fieldset>
        {selected && <p className="tokn-setup-hint">{selected.model_count} models from Tokn’s catalogue will be added automatically. Availability depends on your account; no connection test is sent.</p>}
        {snapshot.setup_providers.length === 0 && <p role="status">Guided setup is unavailable. Use Advanced to configure Tokn.</p>}
        <div className="provider-editor-footer">
          <span className="provider-editor-notice">{connectBlockedReason}</span>
          <div><button type="submit" className="primary" disabled={!canConnect}>
            {busy === "connect" ? "Saving…" : managedAccount ? "Update key" : "Connect"}
          </button></div>
        </div>
      </form>

      <div className={`provider-editor-notice${notice?.error ? " error" : ""}`} role={notice?.error ? "alert" : "status"} aria-live="polite">
        {busy ? busy === "connect" ? "Generating configuration and loading Tokn…" : `${busy === "save" ? "Saving" : busy === "reload" ? "Reloading" : "Validating"}…` : notice?.message}
      </div>

      {snapshot.accounts.length > 0 && (
        <section className="tokn-accounts" aria-labelledby={`${id}-accounts`}>
          <h3 id={`${id}-accounts`}>Saved accounts</h3>
          <ul>{snapshot.accounts.map((account) => (
            <li key={account.account_id}>
              <div><strong>{account.display_name}</strong>
                <span>{account.enabled ? "Enabled" : "Disabled"} · {account.managed ? "API key saved" : "Managed in Advanced"}</span>
                {!account.managed && <code>{account.account_id}</code>}
              </div>
              {account.managed && <button type="button" disabled={busy !== null}
                aria-label={`Replace ${account.display_name} API key`}
                onClick={() => {
                  chooseProvider(account.provider_id);
                  requestAnimationFrame(() => keyInput.current?.focus());
                }}>Replace key</button>}
            </li>
          ))}</ul>
        </section>
      )}

      <details className="tokn-advanced">
        <summary>Advanced{dirty ? " · Unsaved changes" : ""}</summary>
        <div className="tokn-advanced-content">
          <p>Custom routing, model selectors, and imported accounts. You don’t need these for guided setup.</p>
          <ToknAdvancedFields draft={draft} hasCredentials={snapshot.has_credentials} busy={busy !== null}
            onChange={(change) => setDraft((current) => ({ ...current, ...change }))} />
          <footer className="provider-editor-footer">
            <span className="provider-editor-notice">{saveBlockedReason}</span>
            <div>
              {dirty && <button type="button" disabled={busy !== null} onClick={() => { setDraft(createToknDraft(snapshot)); setNotice(null); }}>Discard changes</button>}
              <button type="button" disabled={busy !== null} onClick={() => void run("validate")}>Validate</button>
              <button type="button" disabled={busy !== null || dirty || !snapshot.has_credentials || saveBlockedReason !== null} onClick={() => void run("reload")}>Reload</button>
              <button type="button" className="primary" disabled={busy !== null || !dirty || saveBlockedReason !== null} onClick={() => void run("save")}>Save advanced</button>
            </div>
          </footer>
        </div>
      </details>
      <p className="tokn-storage-note">Credentials are stored unencrypted in private native files. They are not synced between devices.</p>
    </article>
  );
}
