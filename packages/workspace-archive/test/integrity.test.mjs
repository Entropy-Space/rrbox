import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Hex } from "../src/integrity.ts";

const encoder = new TextEncoder();

test("matches fixed SHA-256 vectors", () => {
  assert.equal(
    sha256Hex(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256Hex(encoder.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Hex(
      encoder.encode(
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      ),
    ),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("matches Node SHA-256 across block and padding boundaries", () => {
  const boundaryLengths = [
    0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129,
  ];

  for (const byteLength of boundaryLengths) {
    const storage = new Uint8Array(byteLength + 17);
    for (let index = 0; index < storage.byteLength; index += 1) {
      storage[index] = (index * 37 + 11) & 0xff;
    }
    const bytes = storage.subarray(7, 7 + byteLength);

    assert.equal(
      sha256Hex(bytes),
      createHash("sha256").update(bytes).digest("hex"),
      `SHA-256 mismatch at ${byteLength} bytes`,
    );
  }
});
