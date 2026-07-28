export function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireAllowedFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedFields);
  const unexpected = Object.keys(value).find(
    (field) => !allowed.has(field),
  );
  if (unexpected !== undefined) {
    throw new Error(`${label} has an unexpected ${unexpected} field.`);
  }
}

export function hasOwnField(
  value: Record<string, unknown>,
  field: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

export function requireArray(
  value: unknown,
  field: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value;
}

export function requireNonEmptyString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

export function requireBoolean(
  value: unknown,
  field: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

export function requireString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

export function requireNullableString(
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  return requireString(value, field);
}

export function requireNonNegativeSafeInteger(
  value: unknown,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

export function requireNullableNonNegativeSafeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === null) return null;
  return requireNonNegativeSafeInteger(value, field);
}

export function requireNull(value: unknown, field: string): null {
  if (value !== null) {
    throw new Error(`${field} must be null.`);
  }
  return null;
}

export function requireEnum<
  const TValues extends readonly string[],
>(
  value: unknown,
  values: TValues,
  field: string,
): TValues[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${field} has an unsupported value.`);
  }
  return value;
}

export function requireExactValue<
  const TValue extends string,
>(
  value: unknown,
  expected: TValue,
  field: string,
): TValue {
  if (value !== expected) {
    throw new Error(`${field} must be ${expected}.`);
  }
  return expected;
}

export function validateWorkspaceHandle(
  value: unknown,
  label: string,
): void {
  const handle = requireRecord(value, label);
  requireAllowedFields(
    handle,
    ["project_id", "incarnation_id"],
    label,
  );
  requireNonEmptyString(handle.project_id, "workspace.project_id");
  requireNonEmptyString(
    handle.incarnation_id,
    "workspace.incarnation_id",
  );
}
