/** Opaque, case-sensitive provider ID, not a global vocabulary of effort levels. */
export type ModelReasoningEffort = string;

export type ModelReasoningEffortOption = {
  id: ModelReasoningEffort;
  display_name: string;
  description?: string;
};

const encoder = new TextEncoder();

export function parseModelReasoningEffort(value: unknown): ModelReasoningEffort {
  const id = boundedText(value, "reasoning effort ID", 128);
  // Existing saved selections use this sentinel for Auto. It is never a wire ID.
  if (id === "default") {
    throw new Error("default is reserved for automatic reasoning effort.");
  }
  return id;
}

export function reasoningEffortDisplayName(id: string): string {
  const [first, ...rest] = id;
  return (first?.toUpperCase() ?? "") + rest.join("");
}

/** Accept older string-only catalogs/settings, but always emit structured options. */
export function parseModelReasoningEfforts(
  value: unknown,
): ModelReasoningEffortOption[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("reasoning_efforts must be an array of at most 64 options.");
  }
  const options = value.map((entry): ModelReasoningEffortOption => {
    if (typeof entry === "string") {
      const id = parseModelReasoningEffort(entry);
      return { id, display_name: reasoningEffortDisplayName(id) };
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Invalid reasoning effort option.");
    }
    const option = entry as Record<string, unknown>;
    return {
      id: parseModelReasoningEffort(option.id),
      display_name: boundedText(option.display_name, "reasoning effort display_name", 256),
      ...(option.description === undefined ? {} : {
        description: boundedText(option.description, "reasoning effort description", 1024),
      }),
    };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new Error("Duplicate reasoning effort ID.");
  }
  return options;
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    /[\p{Cc}\p{Surrogate}]/u.test(value) || encoder.encode(value).length > maxBytes
  ) {
    throw new Error(`Invalid ${field}: expected non-empty text of at most ${maxBytes} UTF-8 bytes without surrounding whitespace or control characters.`);
  }
  return value;
}
