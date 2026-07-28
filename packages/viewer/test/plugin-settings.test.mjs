import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyPluginSettings,
  loadPluginSettings,
  parsePluginSettings,
  resolvePluginSetting,
  savePluginSettings,
  updatePluginSetting,
} from "../src/plugin-settings.ts";

const python = {
  plugin_id: "python",
  display_name: "Python",
  description: "Run Python.",
  default_enabled: false,
  configuration_fields: [
    {
      kind: "number",
      configuration_key: "timeout_seconds",
      display_name: "Timeout",
      description: "Maximum runtime.",
      default_value: 15,
      minimum: 1,
      maximum: 60,
      step: 1,
    },
  ],
};

test("persists strict versioned plugin settings", () => {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  const settings = updatePluginSetting(
    emptyPluginSettings(),
    "python",
    {
      enabled: true,
      configuration: { timeout_seconds: 20 },
    },
  );

  savePluginSettings(settings, storage);
  assert.deepEqual(loadPluginSettings(storage), settings);
  assert.deepEqual(resolvePluginSetting(settings, python), {
    enabled: true,
    configuration: { timeout_seconds: 20 },
  });
});

test("falls back safely when stored plugin settings are corrupt", () => {
  const storage = {
    getItem() {
      return "{not-json";
    },
    setItem() {},
  };
  assert.deepEqual(loadPluginSettings(storage), emptyPluginSettings());
  assert.throws(
    () =>
      parsePluginSettings({
        protocol_version: 1,
        plugins: {
          python: {
            enabled: true,
            configuration: { timeoutSeconds: 20 },
          },
        },
      }),
    /Invalid configuration entry/u,
  );
});
