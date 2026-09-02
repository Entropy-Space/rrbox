import assert from "node:assert/strict";
import test from "node:test";
import { createToknDraft, isToknDraftDirty, toToknSettingsInput } from "../src/tokn-settings-draft.ts";

const snapshot = {
  enabled: true, config_toml: '[defaults]\nmode = "exact"\n',
  model_ids: ["deepseek/deepseek-chat"], has_credentials: true, status: "ready",
  accounts: [], setup_providers: [],
};

test("Advanced drafts start clean and never prefill saved credentials", () => {
  const draft = createToknDraft(snapshot);
  assert.equal(isToknDraftDirty(draft, snapshot), false);
  assert.equal(draft.credentials_yaml, "");
  assert.equal(draft.remove_credentials, false);
  assert.equal("credentials_yaml" in toToknSettingsInput(draft), false);
});

test("every Advanced change blocks guided setup until saved or discarded", () => {
  const draft = createToknDraft(snapshot);
  for (const change of [{ enabled: false }, { config_toml: "" }, { models_text: "different/model" },
    { credentials_yaml: "new credentials" }, { remove_credentials: true }]) {
    assert.equal(isToknDraftDirty({ ...draft, ...change }, snapshot), true);
  }
  assert.equal(isToknDraftDirty(createToknDraft(snapshot), snapshot), false);
});

test("Advanced model lines normalize while credential omission, replacement, and removal stay distinct", () => {
  const draft = createToknDraft(snapshot);
  assert.deepEqual(toToknSettingsInput({ ...draft, models_text: " a/model \r\n\n b/model " }).model_ids, ["a/model", "b/model"]);
  assert.equal(toToknSettingsInput({ ...draft, credentials_yaml: "replacement" }).credentials_yaml, "replacement");
  assert.equal(toToknSettingsInput({ ...draft, remove_credentials: true, credentials_yaml: "replacement" }).credentials_yaml, "");
});
