import assert from "node:assert/strict";
import test from "node:test";
import { parseModelReasoningEffort, parseModelReasoningEfforts } from "../src/index.ts";

test("accepts opaque provider IDs and preserves ordered labels and descriptions", () => {
  const options = [
    { id: "ultra", display_name: "Think deeply", description: "Provider-defined budget." },
    { id: "vendor:adaptive-v2", display_name: "Adaptive" },
    { id: "ULTRA", display_name: "A different case-sensitive option" },
  ];
  assert.deepEqual(parseModelReasoningEfforts(options), options);
  assert.notEqual(parseModelReasoningEfforts(options)[0], options[0]);
  for (const { id } of options) assert.equal(parseModelReasoningEffort(id), id);
});

test("normalizes legacy string arrays without sorting or guessing supported levels", () => {
  assert.deepEqual(parseModelReasoningEfforts(["ultra", "low"]), [
    { id: "ultra", display_name: "Ultra" },
    { id: "low", display_name: "Low" },
  ]);
  assert.deepEqual(parseModelReasoningEfforts([]), []);
});

test("validates bounded structure, not a fixed vocabulary", () => {
  for (const id of [undefined, null, true, 2, {}, "", "default", " ultra", "ultra ", "a\n", "a\0b", "a\u0085b", "\ud800", "a".repeat(129), "思".repeat(43)]) {
    assert.throws(() => parseModelReasoningEffort(id));
  }
  assert.equal(parseModelReasoningEffort("a".repeat(128)).length, 128);
  for (const options of [undefined, null, true, {}, ["ultra", "ultra"], ["ultra", { id: "ultra", display_name: "Duplicate" }],
    [{ id: "ultra" }], [{ id: "ultra", display_name: "" }], [{ id: "ultra", display_name: "x".repeat(257) }],
    [{ id: "ultra", display_name: "Ultra", description: null }], [{ id: "ultra", display_name: "Ultra", description: "x".repeat(1025) }],
    Array.from({ length: 65 }, (_, index) => `effort-${index}`),
  ]) assert.throws(() => parseModelReasoningEfforts(options));
});
