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
  setup_providers: ToknSetupProvider[];
  accounts: ToknAccountSummary[];
};

export type ToknConnectInput = {
  provider_id: string;
  api_key: string;
};

export type ToknSetupProvider = {
  provider_id: string;
  display_name: string;
  model_count: number;
};

export type ToknAccountSummary = {
  account_id: string;
  provider_id: string;
  display_name: string;
  enabled: boolean;
  has_api_key: boolean;
  managed: boolean;
};

export type ToknSettingsAdapter = {
  connect(input: ToknConnectInput): Promise<ProviderSettingsSnapshot>;
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
    setup_providers: parseList(record.setup_providers, parseSetupProvider),
    accounts: parseList(record.accounts, parseAccount),
  };
}

function parseList<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  // Older native snapshots can still open the Advanced editor.
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid Tokn setup list.");
  return value.map(parse);
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Tokn setup entry.");
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Tokn ${key}.`);
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Invalid Tokn ${key}.`);
  return value;
}

function parseSetupProvider(value: unknown): ToknSetupProvider {
  const record = recordOf(value);
  if (typeof record.model_count !== "number" || !Number.isSafeInteger(record.model_count) || record.model_count < 0) {
    throw new Error("Invalid Tokn model count.");
  }
  return {
    provider_id: stringField(record, "provider_id"),
    display_name: stringField(record, "display_name"),
    model_count: record.model_count,
  };
}

function parseAccount(value: unknown): ToknAccountSummary {
  const record = recordOf(value);
  return {
    account_id: stringField(record, "account_id"),
    provider_id: stringField(record, "provider_id"),
    display_name: stringField(record, "display_name"),
    enabled: booleanField(record, "enabled"),
    has_api_key: booleanField(record, "has_api_key"),
    managed: booleanField(record, "managed"),
  };
}
