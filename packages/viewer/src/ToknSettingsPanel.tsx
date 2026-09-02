"use client";

import { useId, useState } from "react";
import type { ProviderSettingsSnapshot, ToknSettingsAdapter, ToknSettingsInput, ToknSettingsSnapshot } from "@researchbox/provider-settings";

export function ToknSettingsPanel({ snapshot, adapter, saveBlockedReason, onSaved }: {
  snapshot: ToknSettingsSnapshot;
  adapter: ToknSettingsAdapter;
  saveBlockedReason: string | null;
  onSaved(snapshot: ProviderSettingsSnapshot): void;
}) {
  const id = useId();
  const [enabled, setEnabled] = useState(snapshot.enabled);
  const [config, setConfig] = useState(snapshot.config_toml);
  const [models, setModels] = useState(snapshot.model_ids.join("\n"));
  const [credentials, setCredentials] = useState("");
  const [removeCredentials, setRemoveCredentials] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const dirty = enabled !== snapshot.enabled || config !== snapshot.config_toml ||
    models !== snapshot.model_ids.join("\n") || credentials !== "" || removeCredentials;
  const input: ToknSettingsInput = {
    enabled, config_toml: config,
    model_ids: models.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    ...(removeCredentials ? { credentials_yaml: "" } : credentials ? { credentials_yaml: credentials } : {}),
  };

  async function run(action: "save" | "validate" | "reload") {
    if (busy || (action !== "validate" && saveBlockedReason)) return;
    setBusy(action);
    setNotice(null);
    try {
      if (action === "validate") {
        await adapter.validate(input);
        setNotice({ error: false, message: "Configuration accepted by tokn. No model request was sent." });
      } else {
        const next = action === "save" ? await adapter.save(input) : await adapter.reload();
        setCredentials("");
        setRemoveCredentials(false);
        if (next.embedded_tokn) {
          setEnabled(next.embedded_tokn.enabled);
          setConfig(next.embedded_tokn.config_toml);
          setModels(next.embedded_tokn.model_ids.join("\n"));
        }
        onSaved(next);
        setNotice({ error: false, message: action === "save" ? "Saved on this device." : "Embedded tokn reloaded." });
      }
    } catch (error) {
      setNotice({ error: true, message: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  }

  return <article className="provider-editor" aria-labelledby={`${id}-title`}>
    <div className="provider-editor-heading">
      <div><span>Built-in provider · {snapshot.status}</span><h2 id={`${id}-title`}>Tokn</h2></div>
    </div>
    <p>Runs inside rrbox on desktop and iPhone. No gateway process or localhost URL required.</p>
    {snapshot.status === "unconfigured" && <p role="status">Add account credentials and model selectors to get started.</p>}
    <fieldset disabled={busy !== null} className="provider-editor-fields">
      <label className="provider-field provider-field-wide">
        <span>Routing configuration (TOML)</span>
        <textarea value={config} rows={5} spellCheck={false} onChange={(event) => setConfig(event.target.value)} />
        <small>Supports defaults, profiles, pool, model_families, and proxy. rrbox manages storage and app lifecycle. Do not put credentials here.</small>
      </label>
      <label className="provider-field provider-field-wide">
        <span>Account credentials (auth.yaml)</span>
        <textarea value={credentials} rows={5} spellCheck={false} autoComplete="off" autoCapitalize="none"
          placeholder={snapshot.has_credentials ? "Saved — leave blank to keep" : "version: 1\naccounts:\n  - id: personal\n    provider: openai\n    api_key: YOUR_API_KEY"}
          onChange={(event) => { setCredentials(event.target.value); setRemoveCredentials(false); }} />
        <small>Saved credentials are native-only and never returned to this form. They are stored unencrypted in private files on this device; configuration is not synced.</small>
      </label>
      <label className="provider-field provider-field-wide">
        <span>Model selectors</span>
        <textarea value={models} rows={3} spellCheck={false} autoCapitalize="none" placeholder={"openai/gpt-5\nllama-cpp/local-model"}
          onChange={(event) => setModels(event.target.value)} />
        <small>One tokn model selector or routing alias per line. These populate the model picker; the embedded SDK does not provide automatic discovery.</small>
      </label>
      <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable embedded tokn</label>
      {snapshot.has_credentials && <label><input type="checkbox" checked={removeCredentials} onChange={(event) => {
        setRemoveCredentials(event.target.checked); setCredentials("");
      }} /> Remove saved credentials when saving</label>}
    </fieldset>
    <footer className="provider-editor-footer">
      <span className={`provider-editor-notice${notice?.error ? " error" : ""}`} role={notice?.error ? "alert" : "status"}>
        {busy ? `${busy === "save" ? "Saving" : busy === "reload" ? "Reloading" : "Validating"}…` : notice?.message ?? saveBlockedReason}
      </span>
      <div>
        <button type="button" disabled={busy !== null} onClick={() => void run("validate")}>Validate</button>
        <button type="button" disabled={busy !== null || dirty || !snapshot.has_credentials || saveBlockedReason !== null} onClick={() => void run("reload")}>Reload</button>
        <button type="button" className="primary" disabled={busy !== null || !dirty || saveBlockedReason !== null} onClick={() => void run("save")}>Save tokn</button>
      </div>
    </footer>
  </article>;
}
