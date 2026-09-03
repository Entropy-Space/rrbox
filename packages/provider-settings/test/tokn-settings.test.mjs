import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProviderConfigurationInput, parseProviderRuntimeConfiguration,
  parseProviderSettingsSnapshot, publicProviderRuntimeConfiguration,
} from "../src/index.ts";
import { parseToknSettingsSnapshot } from "../src/tokn.ts";

const provider = {
  backend: "tokn", provider_id: "builtin:tokn", display_name: "Tokn · embedded",
  preset_id: "custom", base_url: "", enabled: true, manual_models: [],
  send_reasoning_content: true, send_session_affinity_headers: true, has_api_key: false,
};

test("configured upstream identities survive native-to-worker projection without nested secrets", () => {
  const upstream_providers = [{ provider_id: "deepseek", display_name: "DeepSeek" }];
  const snapshot = parseProviderSettingsSnapshot({ providers: [{ ...provider,
    upstream_providers: [{ ...upstream_providers[0], api_key: "private" }],
  }] });
  const runtime = parseProviderRuntimeConfiguration(publicProviderRuntimeConfiguration(snapshot.providers[0]));
  assert.deepEqual(runtime.upstream_providers, upstream_providers);
  assert.equal(JSON.stringify(runtime).includes("private"), false);
  assert.throws(() => parseProviderRuntimeConfiguration({ ...provider, upstream_providers: [{ provider_id: "", display_name: "Bad" }] }));
  assert.throws(() => parseProviderRuntimeConfiguration({ ...provider, upstream_providers: [...upstream_providers, ...upstream_providers] }));
});

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

const tokn = {
  enabled: true, config_toml: "", model_ids: ["deepseek/deepseek-chat"], has_credentials: true, status: "ready",
  setup_providers: [{ provider_id: "deepseek", display_name: "DeepSeek", model_count: 2 }],
  accounts: [{ account_id: "owned", provider_id: "deepseek", display_name: "DeepSeek", enabled: true, has_api_key: true, managed: true }],
};

test("Tokn setup snapshots project only public fields and drop nested secrets", () => {
  const parsed = parseToknSettingsSnapshot({ ...tokn, credentials_yaml: "private",
    setup_providers: [{ ...tokn.setup_providers[0], api_key: "private" }],
    accounts: [{ ...tokn.accounts[0], api_key: "private", access_token: "private", extra: { secret: "private" } }],
  });
  assert.deepEqual(parsed, tokn);
  assert.equal(JSON.stringify(parsed).includes("private"), false);
});

test("Tokn setup rejects malformed account metadata and model counts", () => {
  for (const model_count of [-1, 1.5, Infinity, "2"]) {
    assert.throws(() => parseToknSettingsSnapshot({ ...tokn, setup_providers: [{ ...tokn.setup_providers[0], model_count }] }));
  }
  for (const change of [{ enabled: "true" }, { managed: null }, { has_api_key: 1 }, { account_id: "" }, { provider_id: 12 }]) {
    assert.throws(() => parseToknSettingsSnapshot({ ...tokn, accounts: [{ ...tokn.accounts[0], ...change }] }));
  }
  assert.throws(() => parseToknSettingsSnapshot({ ...tokn, accounts: {} }));
});

test("legacy Tokn snapshots retain Advanced settings without setup metadata", () => {
  const legacy = { ...tokn };
  delete legacy.accounts;
  delete legacy.setup_providers;
  assert.deepEqual(parseToknSettingsSnapshot(legacy), { ...legacy, accounts: [], setup_providers: [] });
});
