import type { ToknSettingsInput, ToknSettingsSnapshot } from "@researchbox/provider-settings";

export type ToknSettingsDraft = {
  enabled: boolean;
  config_toml: string;
  models_text: string;
  credentials_yaml: string;
  remove_credentials: boolean;
};

export function createToknDraft(snapshot: ToknSettingsSnapshot): ToknSettingsDraft {
  return {
    enabled: snapshot.enabled,
    config_toml: snapshot.config_toml,
    models_text: snapshot.model_ids.join("\n"),
    credentials_yaml: "",
    remove_credentials: false,
  };
}

export function isToknDraftDirty(draft: ToknSettingsDraft, snapshot: ToknSettingsSnapshot): boolean {
  return draft.enabled !== snapshot.enabled || draft.config_toml !== snapshot.config_toml ||
    draft.models_text !== snapshot.model_ids.join("\n") || draft.credentials_yaml !== "" || draft.remove_credentials;
}

export function toToknSettingsInput(draft: ToknSettingsDraft): ToknSettingsInput {
  return {
    enabled: draft.enabled,
    config_toml: draft.config_toml,
    model_ids: draft.models_text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    ...(draft.remove_credentials ? { credentials_yaml: "" } :
      draft.credentials_yaml ? { credentials_yaml: draft.credentials_yaml } : {}),
  };
}
