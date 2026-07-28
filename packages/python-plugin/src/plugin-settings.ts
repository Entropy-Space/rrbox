import {
  DEFAULT_PYTHON_TIMEOUT_MS,
  MAX_PYTHON_OUTPUT_BYTES,
  MAX_PYTHON_TIMEOUT_MS,
} from "./protocol.ts";

export const pythonPluginCatalogEntry = {
  plugin_id: "python",
  display_name: "Python",
  description:
    "Run calculations and data transformations in a fresh RustPython interpreter.",
  default_enabled: false,
  configuration_fields: [
    {
      kind: "number",
      configuration_key: "timeout_seconds",
      display_name: "Execution timeout",
      description: "Maximum runtime for one Python tool call.",
      default_value: DEFAULT_PYTHON_TIMEOUT_MS / 1_000,
      minimum: 1,
      maximum: MAX_PYTHON_TIMEOUT_MS / 1_000,
      step: 1,
      suffix: "seconds",
    },
    {
      kind: "number",
      configuration_key: "max_output_kib",
      display_name: "Maximum output",
      description: "Combined stdout, stderr, and exception output.",
      default_value: MAX_PYTHON_OUTPUT_BYTES / 1_024,
      minimum: 1,
      maximum: MAX_PYTHON_OUTPUT_BYTES / 1_024,
      step: 1,
      suffix: "KiB",
    },
  ],
} as const;

export type PythonPluginRuntimeConfiguration = {
  enabled: boolean;
  timeout_ms: number;
  max_output_bytes: number;
};

type StoredPluginSetting = {
  enabled?: unknown;
  configuration?: unknown;
};

export function resolvePythonPluginRuntimeConfiguration(
  setting: StoredPluginSetting | null | undefined,
): PythonPluginRuntimeConfiguration {
  const configuration = isRecord(setting?.configuration)
    ? setting.configuration
    : {};
  const timeoutSeconds = boundedInteger(
    configuration.timeout_seconds,
    DEFAULT_PYTHON_TIMEOUT_MS / 1_000,
    1,
    MAX_PYTHON_TIMEOUT_MS / 1_000,
  );
  const maxOutputKib = boundedInteger(
    configuration.max_output_kib,
    MAX_PYTHON_OUTPUT_BYTES / 1_024,
    1,
    MAX_PYTHON_OUTPUT_BYTES / 1_024,
  );
  return {
    enabled: setting?.enabled === true,
    timeout_ms: timeoutSeconds * 1_000,
    max_output_bytes: maxOutputKib * 1_024,
  };
}

export function parsePythonPluginRuntimeConfiguration(
  value: unknown,
): PythonPluginRuntimeConfiguration {
  if (!isRecord(value)) {
    throw new Error("Python plugin configuration must be an object.");
  }
  const fields = Object.keys(value);
  if (
    fields.length !== 3 ||
    !fields.includes("enabled") ||
    !fields.includes("timeout_ms") ||
    !fields.includes("max_output_bytes") ||
    typeof value.enabled !== "boolean"
  ) {
    throw new Error("Invalid Python plugin configuration.");
  }
  return {
    enabled: value.enabled,
    timeout_ms: boundedInteger(
      value.timeout_ms,
      -1,
      1,
      MAX_PYTHON_TIMEOUT_MS,
    ),
    max_output_bytes: boundedInteger(
      value.max_output_bytes,
      -1,
      1,
      MAX_PYTHON_OUTPUT_BYTES,
    ),
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    if (fallback >= minimum && fallback <= maximum) return fallback;
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
