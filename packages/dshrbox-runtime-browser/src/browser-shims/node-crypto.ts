import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

type HashInput = string | Uint8Array;

class BrowserSha256Hash {
  private readonly hash = sha256.create();

  update(input: HashInput): this {
    this.hash.update(typeof input === "string" ? utf8ToBytes(input) : input);
    return this;
  }

  digest(encoding?: "hex"): string | Uint8Array {
    const digest = this.hash.digest();
    if (encoding === undefined) return digest;
    if (encoding === "hex") return bytesToHex(digest);
    throw new TypeError(`Unsupported digest encoding: ${String(encoding)}`);
  }
}

export function createHash(algorithm: string): BrowserSha256Hash {
  if (algorithm.toLowerCase() !== "sha256") {
    throw new TypeError(`Unsupported hash algorithm: ${algorithm}`);
  }
  return new BrowserSha256Hash();
}

export function randomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("dshrbox requires crypto.randomUUID() in its worker runtime");
  }
  return globalThis.crypto.randomUUID();
}
