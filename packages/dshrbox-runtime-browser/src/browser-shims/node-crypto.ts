export function randomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("dshrbox requires crypto.randomUUID() in its worker runtime");
  }
  return globalThis.crypto.randomUUID();
}
