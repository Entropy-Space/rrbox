import assert from "node:assert/strict";
import test from "node:test";
import { parseModelReasoningEfforts } from "@researchbox/protocol";
import { modelProviderGroups, selectedProviderGroup, providerKindLabel } from "../src/model-provider-groups.ts";
import { buildComposerModelControlSnapshot, quickModelsForProvider, formatComposerEffortLabel } from "../src/composer-model-control.ts";
import { buildComposerModelSuggestions } from "../src/composer-commands.ts";

const model = (id, upstream, efforts = []) => ({
  provider_id: "builtin:tokn", model_id: id, display_name: id,
  upstream_provider_id: upstream, availability: "ready", reasoning_efforts: parseModelReasoningEfforts(efforts),
});
const provider = {
  provider_id: "builtin:tokn", display_name: "Tokn · embedded", kind: "tokn",
  availability: "ready",
  upstream_providers: [
    { provider_id: "deepseek", display_name: "DeepSeek" },
    { provider_id: "zai", display_name: "Z.AI" },
  ],
  models: [
    model("deepseek/deepseek-v4-flash", "deepseek", ["none", "low", "high", "max"]),
    model("zai/glm-5", "zai"),
  ],
};
const selection = { provider_id: "builtin:tokn", model_id: "deepseek/deepseek-v4-flash" };

test("Tokn groups configured upstreams without changing routing or refresh IDs", () => {
  const groups = modelProviderGroups([provider]);
  assert.deepEqual(groups.map((group) => [group.display_name, providerKindLabel(group), group.models.length]), [
    ["DeepSeek", "Tokn", 1], ["Z.AI", "Tokn", 1],
  ]);
  assert.equal(new Set(groups.map((group) => group.group_id)).size, 2);
  assert.ok(groups.every((group) => group.provider_id === "builtin:tokn"));
  assert.equal(selectedProviderGroup(groups, selection)?.display_name, "DeepSeek");
  const snapshot = buildComposerModelControlSnapshot([provider], selection, "max");
  assert.equal(snapshot.model_path, selection.model_id);
  assert.deepEqual(quickModelsForProvider(snapshot.selected_provider).map((model) => model.model_id), [selection.model_id]);
  assert.deepEqual(snapshot.effort_options.map((option) => option.suggestionId), ["default", "none", "low", "high", "max"]);
  assert.equal(formatComposerEffortLabel("max"), "Max");
  assert.equal(snapshot.effort_options.at(-1).isSelected, true);
  assert.equal(buildComposerModelSuggestions([provider], selection, "DeepSeek")[0].providerTitle, "DeepSeek");
});

test("configured upstream rows survive empty, loading, and error states", () => {
  for (const availability of ["ready", "loading", "unavailable"]) {
    const groups = modelProviderGroups([{ ...provider, models: [], availability, status_message: "status" }]);
    assert.deepEqual(groups.map((group) => group.display_name), ["DeepSeek", "Z.AI"]);
    assert.ok(groups.every((group) => group.availability === availability && group.status_message === "status"));
    assert.equal(selectedProviderGroup(groups, selection)?.display_name, "DeepSeek");
  }
});

test("advanced aliases and unavailable saved models remain visible without invented capabilities", () => {
  const groups = modelProviderGroups([{ ...provider, models: [
    ...provider.models, model("my-route", undefined),
    { ...model("deepseek/retired", undefined), availability: "unavailable" },
  ] }]);
  assert.equal(groups[0].models.length, 2);
  assert.equal(groups.at(-1).display_name, "Tokn routes");
  assert.deepEqual(groups.at(-1).models[0].reasoning_efforts, []);
});

test("custom OpenAI-compatible endpoints are not relabeled by their name or model prefixes", () => {
  const groups = modelProviderGroups([{ ...provider, kind: "openai_compatible", display_name: "Tokn" }]);
  assert.equal(groups.length, 1);
  assert.equal(providerKindLabel(groups[0]), "OpenAI compatible");
  assert.equal(groups[0].models.length, 2);
});
