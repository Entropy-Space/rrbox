import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWebSearchPluginRuntimeConfiguration,
  resolveWebSearchPluginRuntimeConfiguration,
} from "../src/plugin-settings.ts";

test("resolves disabled, bounded web search defaults", () => {
  assert.deepEqual(resolveWebSearchPluginRuntimeConfiguration(undefined), {
    enabled: false,
    provider: "auto",
    workflow: "auto-summary",
    timeout_ms: 20_000,
    summary_timeout_ms: 30_000,
    maximum_results: 5,
    max_output_bytes: 64 * 1024,
  });
  assert.deepEqual(
    resolveWebSearchPluginRuntimeConfiguration({
      enabled: true,
      configuration: {
        timeout_seconds: 12,
        summary_timeout_seconds: 18,
        maximum_results: 12,
        max_output_kib: 128,
        provider: "exa",
        workflow: "none",
      },
    }),
    {
      enabled: true,
      provider: "exa",
      workflow: "none",
      timeout_ms: 12_000,
      summary_timeout_ms: 18_000,
      maximum_results: 12,
      max_output_bytes: 128 * 1024,
    },
  );
});

test("strictly parses worker configuration", () => {
  const configuration = {
    enabled: true,
    provider: "auto",
    workflow: "auto-summary",
    timeout_ms: 12_000,
    summary_timeout_ms: 30_000,
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
});
