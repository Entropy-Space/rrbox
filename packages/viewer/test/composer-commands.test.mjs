import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComposerModelSuggestions,
  isImeCommitKey,
  matchComposerCommands,
  modelCommandQuery,
  moveComposerSuggestion,
} from "../src/composer-commands.ts";

test("slash suggestions are limited to a known command at the draft start", () => {
  assert.deepEqual(
    matchComposerCommands("/").map((command) => command.invocation),
    ["/model"],
  );
  assert.deepEqual(
    matchComposerCommands("/Mo").map((command) => command.invocation),
    ["/model"],
  );
  assert.deepEqual(matchComposerCommands("/unknown"), []);
  assert.deepEqual(matchComposerCommands("/usr/bin/env"), []);
  assert.deepEqual(matchComposerCommands("please use /model"), []);
  assert.deepEqual(matchComposerCommands("$skill"), []);
  assert.deepEqual(matchComposerCommands("@resource"), []);
  assert.deepEqual(matchComposerCommands("#topic"), []);
});

test("a model query exists only after the accepted command inserts a space", () => {
  assert.equal(modelCommandQuery("/model"), null);
  assert.equal(modelCommandQuery("/model "), "");
  assert.equal(modelCommandQuery("/model gpt"), "gpt");
  assert.equal(modelCommandQuery("/Model gpt"), null);
});

test("model suggestions include only ready matches and mark the selection", () => {
  const providers = [
    {
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
        },
        {
          provider_id: "openai",
          model_id: "retired",
          display_name: "Retired",
          availability: "unavailable",
        },
      ],
    },
    {
      provider_id: "loading",
      display_name: "Loading provider",
      kind: "openai_compatible",
      availability: "loading",
      models: [],
    },
  ];

  const suggestions = buildComposerModelSuggestions(
    providers,
    { provider_id: "openai", model_id: "gpt-5.4" },
    "5.4",
  );
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].providerTitle, "OpenAI");
  assert.equal(suggestions[0].modelId, "gpt-5.4");
  assert.equal(suggestions[0].isSelected, true);
  assert.deepEqual(
    buildComposerModelSuggestions(
      providers,
      { provider_id: "openai", model_id: "gpt-5.4" },
      "retired",
    ),
    [],
  );
});

test("suggestion navigation wraps and recovers from an invalid index", () => {
  assert.equal(moveComposerSuggestion(0, 3, -1), 2);
  assert.equal(moveComposerSuggestion(2, 3, 1), 0);
  assert.equal(moveComposerSuggestion(-1, 3, 1), 1);
  assert.equal(moveComposerSuggestion(0, 0, 1), -1);
});

test("IME commit Enter is never promoted to a composer action", () => {
  const base = {
    key: "Enter",
    keyCode: 13,
    nativeIsComposing: false,
    compositionIsActive: false,
    lastCompositionEndAt: 0,
    now: 1_000,
  };

  assert.equal(isImeCommitKey({
    ...base,
    nativeIsComposing: true,
  }), true);
  assert.equal(isImeCommitKey({
    ...base,
    compositionIsActive: true,
  }), true);
  assert.equal(isImeCommitKey({
    ...base,
    keyCode: 229,
  }), true);
  assert.equal(isImeCommitKey({
    ...base,
    lastCompositionEndAt: 950,
  }), true);
  assert.equal(isImeCommitKey(base), false);
  assert.equal(isImeCommitKey({
    ...base,
    key: "Tab",
    nativeIsComposing: true,
  }), false);
});
