"use client";

import {
  PROVIDER_PRESETS,
  parseProviderConfigurationInput,
  providerPreset,
  type ProviderConfigurationInput,
  type ProviderModelConfiguration,
  type ProviderPresetId,
  type ProviderPublicConfiguration,
  type ProviderSettingsAdapter,
  type ProviderSettingsSnapshot,
} from "@researchbox/provider-settings";
import { Check, CirclePlus, FlaskConical, Pencil, ServerCog, Trash2, X } from "lucide-react";
import { useId, useMemo, useState } from "react";

type ProviderDraft = ProviderConfigurationInput & {
  api_key: string;
  remove_api_key: boolean;
};

type Notice = {
  kind: "success" | "error";
  message: string;
};

export function OpenAICompatibleSettingsPanel({
  snapshot,
  adapter,
  saveBlockedReason,
  onSaved,
}: {
  snapshot: ProviderSettingsSnapshot;
  adapter: ProviderSettingsAdapter;
  saveBlockedReason: string | null;
  onSaved(snapshot: ProviderSettingsSnapshot): void;
}) {
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const providers = snapshot.providers.filter((provider) => provider.backend !== "tokn");
  const editingProvider = providers.find((provider) => provider.provider_id === editingProviderId);

  return (
    <>
      <div className="provider-toolbar">
        <div>
          <strong>OpenAI-compatible endpoints</strong>
          <span>Enabled providers appear in the model picker after saving.</span>
        </div>
        <button
          className="provider-add-button"
          type="button"
          onClick={() => setEditingProviderId("__new__")}
        >
          <CirclePlus size={16} />
          Add provider
        </button>
      </div>

      {editingProviderId !== null && (
        <ProviderEditor
          key={editingProviderId}
          provider={editingProvider}
          providerIds={providers.map((provider) => provider.provider_id)}
          adapter={adapter}
          saveBlockedReason={saveBlockedReason}
          onCancel={() => setEditingProviderId(null)}
          onSaved={(next) => {
            onSaved(next);
            setEditingProviderId(null);
          }}
        />
      )}

      {providers.length === 0 && editingProviderId === null && (
        <div className="provider-empty-state">
          <ServerCog size={26} />
          <strong>No endpoints configured</strong>
          <span>Add an OpenAI-compatible endpoint to choose its models.</span>
        </div>
      )}

      {providers.length > 0 && (
        <div className="provider-list">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.provider_id}
              provider={provider}
              adapter={adapter}
              saveBlockedReason={saveBlockedReason}
              onEdit={() => setEditingProviderId(provider.provider_id)}
              onRemoved={(next) => {
                onSaved(next);
                if (editingProviderId === provider.provider_id) setEditingProviderId(null);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ProviderCard({
  provider,
  adapter,
  saveBlockedReason,
  onEdit,
  onRemoved,
}: {
  provider: ProviderPublicConfiguration;
  adapter: ProviderSettingsAdapter;
  saveBlockedReason: string | null;
  onEdit(): void;
  onRemoved(snapshot: ProviderSettingsSnapshot): void;
}) {
  const [isRemoving, setRemoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const removeUnavailable = isRemoving || saveBlockedReason !== null;

  async function remove() {
    if (removeUnavailable) return;
    if (!window.confirm(`Remove ${provider.display_name}?`)) return;
    setRemoving(true);
    setNotice(null);
    try {
      onRemoved(await adapter.remove(provider.provider_id));
    } catch (error) {
      setNotice(errorMessage(error));
      setRemoving(false);
    }
  }

  return (
    <article className="provider-card">
      <span className="provider-card-icon" aria-hidden={true}>
        <ServerCog size={19} />
      </span>
      <div className="provider-card-body">
        <div className="provider-card-title">
          <div>
            <h2>{provider.display_name}</h2>
            <code>{provider.provider_id}</code>
          </div>
          <span className={`provider-state ${provider.enabled ? "enabled" : ""}`}>
            {provider.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="provider-card-meta">
          <span>{provider.base_url}</span>
          <span>{provider.has_api_key ? "API key saved" : "No API key"}</span>
          <span>
            {provider.manual_models.length === 0
              ? "Discover models automatically"
              : `${provider.manual_models.length} configured model${
                  provider.manual_models.length === 1 ? "" : "s"
                }`}
          </span>
        </div>
        {notice && <span className="provider-card-notice" role="alert">{notice}</span>}
      </div>
      <div className="provider-card-actions">
        <button type="button" onClick={onEdit}>
          <Pencil size={15} />
          Edit
        </button>
        <button
          className="danger"
          type="button"
          aria-disabled={removeUnavailable}
          title={saveBlockedReason ?? undefined}
          onClick={() => void remove()}
        >
          <Trash2 size={15} />
          {isRemoving ? "Removing…" : "Remove"}
        </button>
      </div>
    </article>
  );
}

function ProviderEditor({
  provider,
  providerIds,
  adapter,
  saveBlockedReason,
  onCancel,
  onSaved,
}: {
  provider?: ProviderPublicConfiguration;
  providerIds: readonly string[];
  adapter: ProviderSettingsAdapter;
  saveBlockedReason: string | null;
  onCancel(): void;
  onSaved(snapshot: ProviderSettingsSnapshot): void;
}) {
  const noticeId = useId();
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    provider ? draftFromProvider(provider) : newProviderDraft(providerIds),
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [isTesting, setTesting] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[] | null>(
    null,
  );
  const validationError = useMemo(
    () => validateDraft(draft, providerIds, provider?.provider_id),
    [draft, provider?.provider_id, providerIds],
  );
  const isDirty =
    provider === undefined ||
    JSON.stringify(storableDraft(draft)) !==
      JSON.stringify(storableProvider(provider)) ||
    draft.api_key.length > 0 ||
    draft.remove_api_key;
  const saveUnavailable =
    !isDirty ||
    validationError !== null ||
    saveBlockedReason !== null ||
    isSaving;
  const testUnavailable = validationError !== null || isTesting;

  function update(patch: Partial<ProviderDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setNotice(null);
    setDiscoveredModels(null);
  }

  function selectPreset(presetId: ProviderPresetId) {
    const preset = providerPreset(presetId);
    update({
      preset_id: presetId,
      display_name:
        draft.display_name === providerPreset(draft.preset_id).display_name
          ? preset.display_name
          : draft.display_name,
      base_url: preset.base_url,
      send_reasoning_content: preset.send_reasoning_content,
      send_session_affinity_headers:
        preset.send_session_affinity_headers,
    });
  }

  async function save() {
    if (saveUnavailable) return;
    setSaving(true);
    setNotice(null);
    try {
      onSaved(await adapter.save(toInput(draft)));
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
      setSaving(false);
    }
  }

  async function test() {
    if (testUnavailable) return;
    setTesting(true);
    setNotice(null);
    setDiscoveredModels(null);
    try {
      const result = await adapter.test(toInput(draft));
      setDiscoveredModels(result.model_ids);
      setNotice({
        kind: "success",
        message: result.model_ids.length === 0
          ? "Connected successfully; the provider returned no models."
          : `Connected successfully and found ${result.model_ids.length} model${
              result.model_ids.length === 1 ? "" : "s"
            }.`,
      });
    } catch (error) {
      setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  }

  function importDiscoveredModels() {
    if (!discoveredModels) return;
    const existing = new Set(draft.manual_models.map((model) => model.model_id));
    const manualModels = [...draft.manual_models];
    for (const modelId of discoveredModels) {
      if (!existing.has(modelId)) manualModels.push(createManualModel(modelId));
    }
    update({ manual_models: manualModels });
  }

  return (
    <article className="provider-editor">
      <div className="provider-editor-heading">
        <div>
          <span>{provider ? "Edit connection" : "New connection"}</span>
          <h2>{provider?.display_name ?? "Add provider"}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Cancel provider editing"
          onClick={onCancel}
        >
          <X size={18} />
        </button>
      </div>

      <div className="provider-editor-fields">
        <label className="provider-field">
          <span>Preset</span>
          <select
            value={draft.preset_id}
            onChange={(event) => selectPreset(event.target.value as ProviderPresetId)}
          >
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.preset_id} value={preset.preset_id}>
                {preset.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="provider-field">
          <span>Provider ID</span>
          <input
            value={draft.provider_id}
            readOnly={provider !== undefined}
            spellCheck={false}
            placeholder="my-provider"
            onChange={(event) => update({ provider_id: event.target.value })}
          />
          <small>Stable identifier used by saved model selections.</small>
        </label>
        <label className="provider-field">
          <span>Display name</span>
          <input
            value={draft.display_name}
            placeholder="My provider"
            onChange={(event) => update({ display_name: event.target.value })}
          />
        </label>
        <label className="provider-field provider-field-wide">
          <span>Base URL</span>
          <input
            type="url"
            value={draft.base_url}
            spellCheck={false}
            placeholder="https://api.example.com/v1"
            onChange={(event) => update({ base_url: event.target.value })}
          />
          <small>rrbox appends /models and /chat/completions.</small>
        </label>
        <label className="provider-field provider-field-wide">
          <span>API key</span>
          <input
            type="password"
            value={draft.api_key}
            autoComplete="off"
            placeholder={provider?.has_api_key ? "Saved — leave blank to keep" : "Optional"}
            onChange={(event) =>
              update({ api_key: event.target.value, remove_api_key: false })}
          />
          <small>The key is intentionally stored as plaintext on this device.</small>
        </label>
        <label className="provider-field provider-field-wide">
          <span>Manual model IDs</span>
          <textarea
            value={draft.manual_models.map((model) => model.model_id).join("\n")}
            placeholder="Optional — one model ID per line"
            rows={3}
            onChange={(event) =>
              update({ manual_models: modelsFromLines(event.target.value) })}
          />
          <small>
            Optional fallbacks or capability overrides. Other models are discovered
            from the provider automatically.
          </small>
        </label>
      </div>

      <div className="provider-option-list">
        <ProviderOption
          title="Enable provider"
          description="Expose this provider in the model picker."
          checked={draft.enabled}
          onChange={(enabled) => update({ enabled })}
        />
        <ProviderOption
          title="Send reasoning content"
          description="Include compatible reasoning fields in chat requests."
          checked={draft.send_reasoning_content}
          onChange={(send_reasoning_content) => update({ send_reasoning_content })}
        />
        <ProviderOption
          title="Send session headers"
          description="Include rrbox session-affinity headers."
          checked={draft.send_session_affinity_headers}
          onChange={(send_session_affinity_headers) =>
            update({ send_session_affinity_headers })}
        />
        {provider?.has_api_key && (
          <ProviderOption
            title="Remove saved API key"
            description="Clear the credential when these changes are saved."
            checked={draft.remove_api_key}
            onChange={(remove_api_key) =>
              update({ remove_api_key, api_key: "" })}
          />
        )}
      </div>

      {discoveredModels && discoveredModels.length > 0 && (
        <div className="provider-discovery-result">
          <span>
            {discoveredModels.slice(0, 4).join(", ")}
            {discoveredModels.length > 4
              ? ` and ${discoveredModels.length - 4} more`
              : ""}
          </span>
          <button type="button" onClick={importDiscoveredModels}>
            Use as manual models
          </button>
        </div>
      )}

      <footer className="provider-editor-footer">
        <span
          id={noticeId}
          className={
            validationError || notice?.kind === "error"
              ? "provider-editor-notice error"
              : "provider-editor-notice"
          }
          role={notice?.kind === "error" ? "alert" : "status"}
        >
          {validationError ??
            notice?.message ??
            (saveBlockedReason
              ? `You can keep editing. ${saveBlockedReason}`
              : "")}
        </span>
        <div>
          <button
            type="button"
            aria-disabled={testUnavailable}
            onClick={() => void test()}
          >
            <FlaskConical size={15} />
            {isTesting ? "Testing…" : "Test connection"}
          </button>
          <button
            className="primary"
            type="button"
            aria-disabled={saveUnavailable}
            aria-describedby={noticeId}
            onClick={() => void save()}
          >
            <Check size={15} />
            {isSaving ? "Saving…" : "Save provider"}
          </button>
        </div>
      </footer>
    </article>
  );
}

function ProviderOption({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function draftFromProvider(provider: ProviderPublicConfiguration): ProviderDraft {
  return {
    provider_id: provider.provider_id,
    display_name: provider.display_name,
    preset_id: provider.preset_id,
    base_url: provider.base_url,
    enabled: provider.enabled,
    manual_models: structuredClone(provider.manual_models),
    send_reasoning_content: provider.send_reasoning_content,
    send_session_affinity_headers: provider.send_session_affinity_headers,
    api_key: "",
    remove_api_key: false,
  };
}

function newProviderDraft(providerIds: readonly string[]): ProviderDraft {
  const preset = providerPreset("openai");
  return {
    provider_id: uniqueProviderId("openai", providerIds),
    display_name: preset.display_name,
    preset_id: preset.preset_id,
    base_url: preset.base_url,
    enabled: true,
    manual_models: [],
    send_reasoning_content: preset.send_reasoning_content,
    send_session_affinity_headers: preset.send_session_affinity_headers,
    api_key: "",
    remove_api_key: false,
  };
}

function uniqueProviderId(preferred: string, providerIds: readonly string[]): string {
  const taken = new Set(providerIds);
  if (!taken.has(preferred)) return preferred;
  let suffix = 2;
  while (taken.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

function createManualModel(modelId: string): ProviderModelConfiguration {
  return {
    model_id: modelId,
    display_name: modelId,
    context_window: null,
    max_output_tokens: null,
    supports_tools: true,
    supports_reasoning: false,
    reasoning_efforts: [],
  };
}

function modelsFromLines(value: string): ProviderModelConfiguration[] {
  const modelIds = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [...new Set(modelIds)].map(createManualModel);
}

function validateDraft(
  draft: ProviderDraft,
  providerIds: readonly string[],
  existingProviderId: string | undefined,
): string | null {
  try {
    parseProviderConfigurationInput(toInput(draft));
    if (
      draft.provider_id !== existingProviderId &&
      providerIds.includes(draft.provider_id)
    ) {
      return "Provider ID is already in use.";
    }
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function toInput(draft: ProviderDraft): ProviderConfigurationInput {
  return {
    provider_id: draft.provider_id,
    display_name: draft.display_name,
    preset_id: draft.preset_id,
    base_url: draft.base_url,
    enabled: draft.enabled,
    manual_models: structuredClone(draft.manual_models),
    send_reasoning_content: draft.send_reasoning_content,
    send_session_affinity_headers: draft.send_session_affinity_headers,
    ...(draft.api_key.length === 0 ? {} : { api_key: draft.api_key }),
    ...(draft.remove_api_key ? { remove_api_key: true } : {}),
  };
}

function storableDraft(draft: ProviderDraft): ProviderConfigurationInput {
  return {
    provider_id: draft.provider_id,
    display_name: draft.display_name,
    preset_id: draft.preset_id,
    base_url: draft.base_url,
    enabled: draft.enabled,
    manual_models: draft.manual_models,
    send_reasoning_content: draft.send_reasoning_content,
    send_session_affinity_headers: draft.send_session_affinity_headers,
  };
}

function storableProvider(
  provider: ProviderPublicConfiguration,
): ProviderConfigurationInput {
  return {
    provider_id: provider.provider_id,
    display_name: provider.display_name,
    preset_id: provider.preset_id,
    base_url: provider.base_url,
    enabled: provider.enabled,
    manual_models: provider.manual_models,
    send_reasoning_content: provider.send_reasoning_content,
    send_session_affinity_headers: provider.send_session_affinity_headers,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
