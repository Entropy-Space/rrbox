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
    provider_display_name: "ResearchBox",
    model_id: researchBoxMockModel.id,
    display_name: researchBoxMockModel.name,
    context_window: researchBoxMockModel.contextWindow,
    max_output_tokens: researchBoxMockModel.maxTokens,
    supports_tools: true,
    supports_reasoning: researchBoxMockModel.reasoning,
    supports_reasoning_effort: false,
  });
});
