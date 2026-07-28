export const PLUGIN_SETTINGS_PROTOCOL_VERSION = 1 as const;
export const PLUGIN_SETTINGS_STORAGE_KEY =
  "researchbox:plugin-settings:v1";

export type PluginConfigurationValue = string | number | boolean;

export type PluginSetting = {
  enabled: boolean;
  configuration: Record<string, PluginConfigurationValue>;
};

export type PluginSettingsDocument = {
  protocol_version: typeof PLUGIN_SETTINGS_PROTOCOL_VERSION;
  plugins: Record<string, PluginSetting>;
};

export type NumberPluginConfigurationField = {
  kind: "number";
  configuration_key: string;
  display_name: string;
  description: string;
  default_value: number;
  minimum: number;
  maximum: number;
  step: number;
  suffix?: string;
};

export type PluginCatalogEntry = {
  plugin_id: string;
  display_name: string;
  description: string;
  default_enabled: boolean;
  configuration_fields: readonly NumberPluginConfigurationField[];
};

export type PluginSettingsStorage = Pick<
  Storage,
  "getItem" | "setItem"
>;

export function emptyPluginSettings(): PluginSettingsDocument {
  return {
    protocol_version: PLUGIN_SETTINGS_PROTOCOL_VERSION,
    plugins: {},
  };
}

export function loadPluginSettings(
  storage?: PluginSettingsStorage,
): PluginSettingsDocument {
  try {
    const target =
      storage ??
      (typeof window === "undefined" ? null : window.localStorage);
    if (target === null) return emptyPluginSettings();
    const serialized = target.getItem(PLUGIN_SETTINGS_STORAGE_KEY);
    return serialized === null
      ? emptyPluginSettings()
      : parsePluginSettings(JSON.parse(serialized));
  } catch {
    return emptyPluginSettings();
  }
}

export function savePluginSettings(
  settings: PluginSettingsDocument,
  storage?: PluginSettingsStorage,
): void {
  const parsed = parsePluginSettings(settings);
  const target =
    storage ??
    (typeof window === "undefined" ? null : window.localStorage);
  if (target === null) {
    throw new Error("Plugin settings storage is unavailable.");
  }
  target.setItem(PLUGIN_SETTINGS_STORAGE_KEY, JSON.stringify(parsed));
}

export function parsePluginSettings(
  value: unknown,
): PluginSettingsDocument {
  const record = requireExactRecord(
    value,
    ["protocol_version", "plugins"],
    "plugin settings",
  );
  if (record.protocol_version !== PLUGIN_SETTINGS_PROTOCOL_VERSION) {
    throw new Error("Unsupported plugin settings version.");
  }
  const pluginsRecord = requireRecord(record.plugins, "plugins");
  const plugins: Record<string, PluginSetting> = {};
  for (const [pluginId, pluginValue] of Object.entries(pluginsRecord)) {
    if (!isPluginId(pluginId)) {
      throw new Error(`Invalid plugin id: ${pluginId}`);
    }
    const plugin = requireExactRecord(
      pluginValue,
      ["enabled", "configuration"],
      `plugin ${pluginId}`,
    );
    if (typeof plugin.enabled !== "boolean") {
      throw new Error(`Plugin ${pluginId} enabled must be boolean.`);
    }
    const configurationRecord = requireRecord(
      plugin.configuration,
      `plugin ${pluginId} configuration`,
    );
    const configuration: Record<string, PluginConfigurationValue> = {};
    for (const [key, configurationValue] of Object.entries(
      configurationRecord,
    )) {
      if (
        !isConfigurationKey(key) ||
        !isConfigurationValue(configurationValue)
      ) {
        throw new Error(
          `Invalid configuration entry for plugin ${pluginId}: ${key}`,
        );
      }
      configuration[key] = configurationValue;
    }
    plugins[pluginId] = {
      enabled: plugin.enabled,
      configuration,
    };
  }
  return {
    protocol_version: PLUGIN_SETTINGS_PROTOCOL_VERSION,
    plugins,
  };
}

export function resolvePluginSetting(
  settings: PluginSettingsDocument,
  plugin: PluginCatalogEntry,
): PluginSetting {
  const stored = settings.plugins[plugin.plugin_id];
  return {
    enabled: stored?.enabled ?? plugin.default_enabled,
    configuration: Object.fromEntries(
      plugin.configuration_fields.map((field) => [
        field.configuration_key,
        stored?.configuration[field.configuration_key] ??
          field.default_value,
      ]),
    ),
  };
}

export function updatePluginSetting(
  settings: PluginSettingsDocument,
  pluginId: string,
  setting: PluginSetting,
): PluginSettingsDocument {
  if (!isPluginId(pluginId)) {
    throw new Error(`Invalid plugin id: ${pluginId}`);
  }
  return parsePluginSettings({
    protocol_version: PLUGIN_SETTINGS_PROTOCOL_VERSION,
    plugins: {
      ...settings.plugins,
      [pluginId]: setting,
    },
  });
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const expected = new Set(fields);
  for (const field of fields) {
    if (!(field in record)) {
      throw new Error(`Missing ${label} field: ${field}.`);
    }
  }
  for (const field of Object.keys(record)) {
    if (!expected.has(field)) {
      throw new Error(`Unknown ${label} field: ${field}.`);
    }
  }
  return record;
}

function isPluginId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}

function isConfigurationKey(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

function isConfigurationValue(
  value: unknown,
): value is PluginConfigurationValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
