import assert from "node:assert/strict";
import test from "node:test";
import {
  createResearchBoxProviderDefinitions,
} from "@researchbox/app-runtime-browser/core-worker";
import {
  researchBoxMockModel,
  researchBoxMockModelDescriptor,
} from "@researchbox/app-runtime-browser/mock-model";

test("builds mock-only and web-enabled provider definitions", () => {
  const mockOnly = createResearchBoxProviderDefinitions({
    include_local_openai: false,
  });
  assert.deepEqual(
    mockOnly.map((provider) => provider.provider_id),
    ["researchbox"],
  );

  const webEnabled = createResearchBoxProviderDefinitions({
    include_local_openai: true,
  });
  assert.deepEqual(
    webEnabled.map((provider) => provider.provider_id),
    ["researchbox", "local-openai"],
  );
  assert.deepEqual(webEnabled[1], {
    provider_id: "local-openai",
    display_name: "OpenAI-compatible · localhost:4141",
    kind: "openai_compatible",
    discover_models: true,
  });
});

test("returns fresh provider and model arrays for every consumer", () => {
  const first = createResearchBoxProviderDefinitions({
    include_local_openai: false,
  });
  const second = createResearchBoxProviderDefinitions({
    include_local_openai: false,
  });

  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first[0], second[0]);
  assert.notStrictEqual(first[0].models, second[0].models);

  first[0].models.pop();
  first.pop();
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].models, [researchBoxMockModel]);
});

test("keeps the shared mock descriptor aligned with the core model", () => {
  assert.deepEqual(researchBoxMockModelDescriptor, {
    provider_id: researchBoxMockModel.provider,
    provider_display_name: "rrbox",
    model_id: researchBoxMockModel.id,
    display_name: researchBoxMockModel.name,
    context_window: researchBoxMockModel.contextWindow,
    max_output_tokens: researchBoxMockModel.maxTokens,
    supports_tools: true,
    supports_reasoning: researchBoxMockModel.reasoning,
    supports_reasoning_effort: false,
    reasoning_efforts: [],
  });
});

test("builds independent OpenAI-compatible definitions from provider settings", () => {
  const [mock, provider] = createResearchBoxProviderDefinitions({
    providers: [{
      provider_id: "example",
      display_name: "Example",
      preset_id: "custom",
      base_url: "https://example.com/v1",
      enabled: true,
      manual_models: [{
        model_id: "model-1",
        display_name: "Model 1",
        context_window: 32_000,
        max_output_tokens: 4_000,
        supports_tools: true,
        supports_reasoning: true,
        reasoning_efforts: [
          { id: "low", display_name: "Low" },
          { id: "high", display_name: "High" },
        ],
      }],
      send_reasoning_content: true,
      send_session_affinity_headers: false,
    }],
  });

  assert.equal(mock.provider_id, "researchbox");
  assert.deepEqual(provider, {
    provider_id: "example",
    display_name: "Example",
    kind: "openai_compatible",
    discover_models: true,
    models: [{
      id: "model-1",
      name: "Model 1",
      api: "openai-completions",
      provider: "example",
      baseUrl: "",
      reasoning: true,
      supports_tools: true,
      supports_reasoning_effort: true,
      reasoning_efforts: [
        { id: "low", display_name: "Low" },
        { id: "high", display_name: "High" },
      ],
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_000,
    }],
  });
});

test("omits disabled provider settings from the agent catalog", () => {
  const providers = createResearchBoxProviderDefinitions({
    providers: [{
      provider_id: "disabled",
      display_name: "Disabled",
      preset_id: "custom",
      base_url: "https://example.com/v1",
      enabled: false,
      manual_models: [],
      send_reasoning_content: false,
      send_session_affinity_headers: false,
    }],
  });
  assert.deepEqual(
    providers.map((provider) => provider.provider_id),
    ["researchbox"],
  );
});

test("embedded Tokn carries configured upstreams into catalog definitions", () => {
  const upstream_providers = [{ provider_id: "deepseek", display_name: "DeepSeek" }];
  const definitions = createResearchBoxProviderDefinitions({ providers: [{
    backend: "tokn", provider_id: "builtin:tokn", display_name: "Tokn · embedded",
    preset_id: "custom", base_url: "", enabled: true, manual_models: [],
    send_reasoning_content: true, send_session_affinity_headers: true, upstream_providers,
  }] });
  assert.equal(definitions[1].kind, "tokn");
  assert.deepEqual(definitions[1].upstream_providers, upstream_providers);
});
