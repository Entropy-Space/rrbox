import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeWebSearchPluginCatalogEntry,
  parseWebSearchPluginRuntimeConfiguration,
  resolveWebSearchPluginRuntimeConfiguration,
  webSearchRoutingProviderIds,
  webSearchPluginCatalogEntry,
} from "../src/plugin-settings.ts";

test("advertises AnySearch only in the native plugin catalog", () => {
  const webProvider = webSearchPluginCatalogEntry.configuration_fields
    .find((field) => field.configuration_key === "provider");
  const nativeProvider =
    nativeWebSearchPluginCatalogEntry.configuration_fields
      .find((field) => field.configuration_key === "provider");
  assert.equal(
    webProvider.options.some((option) => option.value === "anysearch"),
    false,
  );
  assert.equal(
    nativeProvider.options.some((option) => option.value === "anysearch"),
    true,
  );
  assert.equal(
    nativeProvider.options.some((option) => option.value === "all"),
    true,
  );
  assert.deepEqual(
    webSearchRoutingProviderIds("anysearch-exa"),
    ["anysearch", "exa"],
  );
  const reviewDeadline =
    webSearchPluginCatalogEntry.configuration_fields.find(
      (field) => field.configuration_key === "review_timeout_seconds",
    );
  assert.equal(reviewDeadline.default_value, 20);
  assert.equal(reviewDeadline.maximum, 600);
});

test("resolves disabled, bounded web search defaults", () => {
  assert.deepEqual(resolveWebSearchPluginRuntimeConfiguration(undefined), {
    enabled: false,
    provider: "auto",
    routing_order: "exa-anysearch",
    workflow: "summary-review",
    timeout_ms: 20_000,
    summary_timeout_ms: 30_000,
    review_timeout_ms: 20_000,
    maximum_results: 5,
    max_output_bytes: 64 * 1024,
  });
  assert.deepEqual(
    resolveWebSearchPluginRuntimeConfiguration({
      enabled: true,
      configuration: {
        timeout_seconds: 12,
        summary_timeout_seconds: 18,
        review_timeout_seconds: 45,
        maximum_results: 12,
        max_output_kib: 128,
        provider: "exa",
        routing_order: "anysearch-exa",
        workflow: "none",
      },
    }),
    {
      enabled: true,
      provider: "exa",
      routing_order: "anysearch-exa",
      workflow: "none",
      timeout_ms: 12_000,
      summary_timeout_ms: 18_000,
      review_timeout_ms: 45_000,
      maximum_results: 12,
      max_output_bytes: 128 * 1024,
    },
  );
});

test("strictly parses worker configuration", () => {
  const configuration = {
    enabled: true,
    provider: "auto",
    routing_order: "exa-anysearch",
    workflow: "auto-summary",
    timeout_ms: 12_000,
    summary_timeout_ms: 30_000,
    review_timeout_ms: 20_000,
    maximum_results: 12,
    max_output_bytes: 128 * 1024,
  };
  assert.deepEqual(
    parseWebSearchPluginRuntimeConfiguration(configuration),
    configuration,
  );
  assert.throws(
    () =>
      parseWebSearchPluginRuntimeConfiguration({
        ...configuration,
        endpoint: "https://example.com",
      }),
    /Invalid web search plugin configuration/u,
  );
  assert.throws(
    () =>
      parseWebSearchPluginRuntimeConfiguration({
        ...configuration,
        review_timeout_ms: 600_001,
      }),
    /Expected an integer/u,
  );
});
