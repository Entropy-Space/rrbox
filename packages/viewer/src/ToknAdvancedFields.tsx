import type { ToknSettingsDraft } from "./tokn-settings-draft.ts";

export function ToknAdvancedFields({ draft, hasCredentials, busy, onChange }: {
  draft: ToknSettingsDraft;
  hasCredentials: boolean;
  busy: boolean;
  onChange(change: Partial<ToknSettingsDraft>): void;
}) {
  return (
    <fieldset disabled={busy} className="provider-editor-fields">
      <label className="provider-field provider-field-wide">
        <span>Routing configuration (TOML)</span>
        <textarea value={draft.config_toml} rows={5} spellCheck={false}
          onChange={(event) => onChange({ config_toml: event.target.value })} />
        <small>Supports defaults, profiles, pool, model_families, and proxy. Do not put credentials here.</small>
      </label>
      <label className="provider-field provider-field-wide">
        <span>Replace all account credentials (auth.yaml)</span>
        <textarea value={draft.credentials_yaml} rows={5} spellCheck={false} autoComplete="off" autoCapitalize="none"
          placeholder={hasCredentials ? "Saved — leave blank to keep all accounts" : "version: 1\naccounts:\n  - id: personal\n    provider: openai\n    api_key: YOUR_API_KEY"}
          onChange={(event) => onChange({ credentials_yaml: event.target.value, remove_credentials: false })} />
        <small>Replacing this document replaces every account. Replaced accounts are managed here, not by guided setup. Saved credentials are never returned to the form.</small>
      </label>
      <label className="provider-field provider-field-wide">
        <span>Model selectors</span>
        <textarea value={draft.models_text} rows={3} spellCheck={false} autoCapitalize="none"
          placeholder={"openai/gpt-5\nllama-cpp/local-model"}
          onChange={(event) => onChange({ models_text: event.target.value })} />
        <small>Guided setup adds models from Tokn’s catalogue. Add or remove selectors here to customize the model picker.</small>
      </label>
      <label><input type="checkbox" checked={draft.enabled}
        onChange={(event) => onChange({ enabled: event.target.checked })} /> Enable embedded Tokn</label>
      {hasCredentials && <label><input type="checkbox" checked={draft.remove_credentials}
        onChange={(event) => onChange({ remove_credentials: event.target.checked, credentials_yaml: "" })} /> Remove all saved credentials when saving</label>}
    </fieldset>
  );
}
