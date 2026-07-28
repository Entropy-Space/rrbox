import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWebSearchPluginRuntimeConfiguration,
  resolveWebSearchPluginRuntimeConfiguration,
} from "../src/plugin-settings.ts";

test("resolves disabled, bounded web search defaults", () => {
  assert.deepEqual(resolveWebSearchPluginRuntimeConfiguration(undefined), {
    enabled: false,
    timeout_ms: 20_000,
    maximum_results: 5,
    max_output_bytes: 64 * 1024,
  });
  assert.deepEqual(
    resolveWebSearchPluginRuntimeConfiguration({
      enabled: true,
      configuration: {
        timeout_seconds: 12,
        maximum_results: 8,
        max_output_kib: 128,
      },
    }),
    {
      enabled: true,
      timeout_ms: 12_000,
      maximum_results: 8,
      max_output_bytes: 128 * 1024,
    },
  );
});

test("strictly parses worker configuration", () => {
  const configuration = {
    enabled: true,
    timeout_ms: 12_000,
    maximum_results: 8,
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
