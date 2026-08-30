/** Stable application identity for one native DSH tool-call block. */
export function dshrboxToolCallBlockId(
  sessionId: string,
  turn: number,
  step: number,
  callId: string,
): string {
  return [
    "dshrbox",
    identitySegment(requireIdentifier(sessionId, "session_id")),
    "turn",
    String(requireNonNegativeInteger(turn, "turn")),
    "step",
    String(requireNonNegativeInteger(step, "step")),
    "assistant",
    "tool-call",
    identitySegment(requireIdentifier(callId, "call_id")),
  ].join(":");
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function identitySegment(value: string): string {
  return encodeURIComponent(value);
}
