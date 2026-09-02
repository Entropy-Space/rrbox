import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProviderConfigurationInput, parseProviderRuntimeConfiguration,
  parseProviderSettingsSnapshot, publicProviderRuntimeConfiguration,
} from "../src/index.ts";

const provider = {
  backend: "tokn", provider_id: "builtin:tokn", display_name: "Tokn · embedded",
  preset_id: "custom", base_url: "", enabled: true, manual_models: [],
  send_reasoning_content: true, send_session_affinity_headers: true, has_api_key: false,
};

test("embedded backend survives public snapshot and native worker projection without credentials", () => {
  const snapshot = parseProviderSettingsSnapshot({
    providers: [provider], embedded_tokn: {
      enabled: true, config_toml: '[defaults]\nmode = "exact"\n', model_ids: ["openai/example"],
      has_credentials: true, status: "ready", credentials_yaml: "must-not-escape",
    },
  });
  const runtime = parseProviderRuntimeConfiguration(publicProviderRuntimeConfiguration(snapshot.providers[0]));
  assert.equal(runtime.backend, "tokn");
  assert.equal(runtime.base_url, "");
  assert.equal(JSON.stringify(snapshot).includes("must-not-escape"), false);
  assert.equal("api_key" in runtime, false);
});

test("embedded IDs and endpoints cannot be saved through custom endpoint settings", () => {
  assert.throws(() => parseProviderConfigurationInput(provider), /embedded tokn/);
  assert.throws(() => parseProviderRuntimeConfiguration({ ...provider, base_url: "https://example.com" }), /Invalid embedded/);
  assert.throws(() => parseProviderRuntimeConfiguration({ ...provider, provider_id: "arbitrary" }), /Invalid embedded/);
  assert.throws(() => parseProviderRuntimeConfiguration({ ...provider, backend: "unknown" }), /Unknown provider backend/);
});

test("built-in namespace does not reserve previously valid custom IDs", () => {
  const existing = parseProviderConfigurationInput({
    ...provider, backend: "openai_compatible", provider_id: "builtin-tokn", base_url: "http://127.0.0.1:4141/v1",
  });
  assert.equal(existing.provider_id, "builtin-tokn");
});
