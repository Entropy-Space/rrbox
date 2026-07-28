import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePythonPluginRuntimeConfiguration,
  resolvePythonPluginRuntimeConfiguration,
} from "../src/plugin-settings.ts";

test("resolves disabled defaults and converts persisted display units", () => {
  assert.deepEqual(resolvePythonPluginRuntimeConfiguration(undefined), {
    enabled: false,
    timeout_ms: 15_000,
    max_output_bytes: 1024 * 1024,
  });
  assert.deepEqual(
    resolvePythonPluginRuntimeConfiguration({
      enabled: true,
      configuration: {
        timeout_seconds: 8,
        max_output_kib: 64,
      },
    }),
    {
      enabled: true,
      timeout_ms: 8_000,
      max_output_bytes: 64 * 1024,
    },
  );
});

test("validates the strict runtime configuration", () => {
  const configuration = {
    enabled: true,
    timeout_ms: 8_000,
    max_output_bytes: 64 * 1024,
  };
  assert.deepEqual(
    parsePythonPluginRuntimeConfiguration(configuration),
    configuration,
  );
  assert.throws(
    () =>
      parsePythonPluginRuntimeConfiguration({
        ...configuration,
        timeout_ms: 0,
      }),
    /Expected an integer/u,
  );
});
