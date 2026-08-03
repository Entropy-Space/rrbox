import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComposerModelControlSnapshot,
  formatComposerEffortLabel,
  quickModelsForProvider,
  reasoningSliderIndex,
} from "../src/composer-model-control.ts";

const providers = [{
  provider_id: "openai",
  display_name: "OpenAI",
  kind: "openai_compatible",
  availability: "ready",
  models: [
    {
      provider_id: "openai",
      model_id: "gpt-5.4",
      display_name: "GPT-5.4",
      availability: "ready",
      reasoning_efforts: ["none", "low", "medium", "high"],
    },
    {
      provider_id: "openai",
      model_id: "retired",
      display_name: "Retired",
      availability: "unavailable",
      reasoning_efforts: [],
    },
  ],
}];

test("composer model control resolves its path, status, and effort steps", () => {
  const snapshot = buildComposerModelControlSnapshot(
    providers,
    { provider_id: "openai", model_id: "gpt-5.4" },
    "medium",
  );

  assert.equal(snapshot.model_path, "openai/gpt-5.4");
  assert.equal(snapshot.model_availability, "ready");
  assert.equal(snapshot.model_status, "Model ready");
  assert.equal(snapshot.selected_provider?.display_name, "OpenAI");
  assert.equal(snapshot.selected_model?.display_name, "GPT-5.4");
  assert.deepEqual(
    snapshot.effort_options.map((option) => option.suggestionId),
    ["default", "none", "low", "medium", "high"],
  );
  assert.equal(reasoningSliderIndex(snapshot.effort_options, "medium"), 3);
});

test("composer model control keeps pending and unavailable states explicit", () => {
  assert.deepEqual(
    buildComposerModelControlSnapshot(
      [{
        provider_id: "loading",
        display_name: "Loading",
        kind: "openai_compatible",
        availability: "loading",
        models: [],
      }],
      { provider_id: "", model_id: "" },
      "default",
    ).model_availability,
    "loading",
  );
  assert.equal(
    buildComposerModelControlSnapshot(
      providers,
      { provider_id: "missing", model_id: "unknown" },
      "default",
    ).model_availability,
    "unavailable",
  );
});

test("quick models and compact effort labels expose only useful choices", () => {
  assert.deepEqual(
    quickModelsForProvider(providers[0]).map((model) => model.model_id),
    ["gpt-5.4"],
  );
  assert.equal(formatComposerEffortLabel("default"), "Auto");
  assert.equal(formatComposerEffortLabel("none"), "Off");
  assert.equal(formatComposerEffortLabel("minimal"), "Min");
  assert.equal(formatComposerEffortLabel("medium"), "Medium");
  assert.equal(formatComposerEffortLabel("xhigh"), "XHigh");
  assert.equal(reasoningSliderIndex([], "high"), 0);
});
