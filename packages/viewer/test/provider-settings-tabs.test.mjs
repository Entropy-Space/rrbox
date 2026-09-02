import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROVIDER_SETTINGS_TABS, providerSettingsTabForKey } from "../src/provider-settings-tabs.ts";

test("provider tabs separate embedded routing from compatible endpoints", () => {
  assert.deepEqual(PROVIDER_SETTINGS_TABS, [
    { id: "tokn", label: "Tokn" },
    { id: "openai_compatible", label: "OpenAI-compatible" },
  ]);
});

test("horizontal provider tab navigation wraps and supports Home and End", () => {
  for (const current of ["tokn", "openai_compatible"]) {
    const other = current === "tokn" ? "openai_compatible" : "tokn";
    assert.equal(providerSettingsTabForKey(current, "ArrowLeft"), other);
    assert.equal(providerSettingsTabForKey(current, "ArrowRight"), other);
    assert.equal(providerSettingsTabForKey(current, "Home"), "tokn");
    assert.equal(providerSettingsTabForKey(current, "End"), "openai_compatible");
  }
});

test("provider tabs leave normal tabbing, activation, and vertical scrolling alone", () => {
  for (const key of ["Tab", "Enter", " ", "ArrowUp", "ArrowDown", "Escape", "a"]) {
    assert.equal(providerSettingsTabForKey("tokn", key), null);
  }
});

const [source, styles, endpoints] = await Promise.all([
  readFile(new URL("../src/ProvidersPage.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/OpenAICompatibleSettingsPanel.tsx", import.meta.url), "utf8"),
]);

test("switching tabs hides mounted editors without mutating provider settings", () => {
  assert.match(source, /hidden=\{activeTab !== "tokn"\}/u);
  assert.match(source, /hidden=\{activeTab !== "openai_compatible"\}/u);
  assert.doesNotMatch(source, /activeTab === [^\n]+&&/u);
  assert.doesNotMatch(source, /adapter\.(save|remove|test|tokn\.(save|reload|validate))\(/u);
  assert.match(styles, /\.provider-settings-panel\[hidden\]\s*\{\s*display: none;/u);
  assert.match(endpoints, /provider\.backend !== "tokn"/u);
});

test("provider tabs expose linked panels, roving focus, and an endpoints-only fallback", () => {
  assert.match(source, /role="tablist" aria-label="Provider configuration"/u);
  assert.match(source, /role="tab"/u);
  assert.match(source, /aria-controls=/u);
  assert.match(source, /aria-selected=\{activeTab === tab\.id\}/u);
  assert.match(source, /tabIndex=\{activeTab === tab\.id \? 0 : -1\}/u);
  assert.match(source, /tabRefs\.current\[next\]\?\.focus\(\)/u);
  assert.match(source, /adapter\.tokn \? "tokn" : "openai_compatible"/u);
  assert.match(source, /const activeTab = hasTokn \? selectedTab : "openai_compatible"/u);
  assert.match(source, /hasTokn && \(/u);
});

test("provider tabs remain touch-sized and fit the phone viewport", () => {
  assert.match(styles, /\.provider-tabs button\s*\{[^}]*min-height: 44px/u);
  const phoneStyles = styles.slice(styles.indexOf("@media (max-width: 768px)"));
  assert.match(phoneStyles, /\.provider-tabs\s*\{\s*width: 100%;/u);
});
