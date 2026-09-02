import type { ProviderSettingsSnapshot } from "./index.ts";

// Custom provider IDs cannot contain ':', so existing IDs can never collide.
export const EMBEDDED_TOKN_PROVIDER_ID = "builtin:tokn";

export type ToknSettingsInput = {
  enabled: boolean;
  config_toml: string;
  model_ids: string[];
  /** Omitted preserves credentials; an empty string removes them. */
  credentials_yaml?: string;
};

export type ToknSettingsSnapshot = {
  enabled: boolean;
  config_toml: string;
  model_ids: string[];
  has_credentials: boolean;
  status: "unconfigured" | "disabled" | "configured" | "ready";
};

export type ToknSettingsAdapter = {
  save(input: ToknSettingsInput): Promise<ProviderSettingsSnapshot>;
  validate(input: ToknSettingsInput): Promise<void>;
  reload(): Promise<ProviderSettingsSnapshot>;
};

export function parseToknSettingsSnapshot(value: unknown): ToknSettingsSnapshot {
  if (typeof value !== "object" || value === null) throw new Error("Invalid tokn settings.");
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean" || typeof record.has_credentials !== "boolean" ||
    typeof record.config_toml !== "string" || !Array.isArray(record.model_ids) ||
    !record.model_ids.every((id) => typeof id === "string" && id.trim()) ||
    !["unconfigured", "disabled", "configured", "ready"].includes(String(record.status))) {
    throw new Error("Invalid tokn settings snapshot.");
  }
  return {
    enabled: record.enabled, config_toml: record.config_toml,
    model_ids: record.model_ids as string[], has_credentials: record.has_credentials,
    status: record.status as ToknSettingsSnapshot["status"],
  };
}
