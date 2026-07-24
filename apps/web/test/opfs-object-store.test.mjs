import assert from "node:assert/strict";
import test from "node:test";
import {
  OpfsWorkspaceObjectStore,
  WorkspaceObjectIntegrityError,
} from "../browser/persistence/opfs-object-store.ts";

test("OPFS object store round-trips and deduplicates content", async () => {
  const root = new MemoryOpfsDirectory();
  const store = createStore(root);

  const first = await store.write("storage-1", "alpha");
  assert.match(first.content_id, /^[0-9a-f]{64}$/);
  assert.deepEqual(first, {
    content_id:
      "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018" +
      "e8f2223f8",
    byte_size: 5,
  });
  assert.equal(await store.read("storage-1", first.content_id), "alpha");
  assert.equal(root.createWritableCount, 1);

  assert.deepEqual(await store.write("storage-1", "alpha"), first);
  assert.equal(root.createWritableCount, 1);
});

test("OPFS object store preserves Unicode content in an opaque namespace", async () => {
  const root = new MemoryOpfsDirectory();
  const store = createStore(root);
  const storageId = "研究/../🔬";
  const content = "你好, κόσμε 🌍\nRésumé";

  const result = await store.write(storageId, content);

  assert.equal(
    result.byte_size,
    new TextEncoder().encode(content).byteLength,
  );
  assert.equal(await store.read(storageId, result.content_id), content);
  assert.equal(root.directoryNames.length, 1);
  assert.match(root.directoryNames[0], /^workspace-[0-9a-f]{64}$/);
  assert.equal(root.directoryNames[0].includes(storageId), false);
});

test("OPFS object store fails closed on corrupt content and can repair it", async () => {
  const root = new MemoryOpfsDirectory();
  const store = createStore(root);
  const result = await store.write("storage-1", "trusted");

  root.replaceFilesNamed(
    result.content_id,
    new TextEncoder().encode("tampered"),
  );

  await assert.rejects(
    store.read("storage-1", result.content_id),
    (error) => {
      assert.equal(error instanceof WorkspaceObjectIntegrityError, true);
      assert.equal(error.expected_content_id, result.content_id);
      assert.match(error.actual_content_id, /^[0-9a-f]{64}$/);
      return true;
    },
  );

  assert.deepEqual(await store.write("storage-1", "trusted"), result);
  assert.equal(await store.read("storage-1", result.content_id), "trusted");
});

test("a failed close preserves prior bytes and an idempotent retry repairs them", async () => {
  const root = new MemoryOpfsDirectory();
  const store = createStore(root);
  const result = await store.write("storage-1", "trusted");
  const priorBytes = new TextEncoder().encode("prior corrupt bytes");
  root.replaceFilesNamed(result.content_id, priorBytes);
  root.failNextClose("before_commit");

  await assert.rejects(
    store.write("storage-1", "trusted"),
    /close failed before commit/,
  );
  assert.deepEqual(root.bytesForFileNamed(result.content_id), priorBytes);
  await assert.rejects(
    store.read("storage-1", result.content_id),
    WorkspaceObjectIntegrityError,
  );

  assert.deepEqual(await store.write("storage-1", "trusted"), result);
  assert.equal(await store.read("storage-1", result.content_id), "trusted");
});

test("a post-close fault is recovered by a deduplicated retry", async () => {
  const root = new MemoryOpfsDirectory();
  const store = createStore(root);
  root.failNextClose("after_commit");

  await assert.rejects(
    store.write("storage-1", "committed"),
    /close failed after commit/,
  );
  assert.equal(root.createWritableCount, 1);

  const result = await store.write("storage-1", "committed");
  assert.equal(root.createWritableCount, 1);
  assert.equal(await store.read("storage-1", result.content_id), "committed");
});

test("objects and storage namespaces delete idempotently in isolation", async () => {
  const root = new MemoryOpfsDirectory();
  const store = createStore(root);
  const first = await store.write("storage-a", "shared");
  const second = await store.write("storage-b", "shared");

  assert.equal(first.content_id, second.content_id);
  assert.equal(root.directoryNames.length, 2);

  await store.deleteObject("storage-a", first.content_id);
  await assert.rejects(
    store.read("storage-a", first.content_id),
    hasName("NotFoundError"),
  );
  assert.equal(
    await store.read("storage-b", second.content_id),
    "shared",
  );
  await store.deleteObject("storage-a", first.content_id);

  await store.deleteStorage("storage-a");
  await assert.rejects(
    store.read("storage-a", first.content_id),
    hasName("NotFoundError"),
  );
  assert.equal(
    await store.read("storage-b", second.content_id),
    "shared",
  );

  await store.deleteStorage("storage-a");
  await store.deleteStorage("never-created");
  assert.equal(root.directoryNames.length, 1);
});

test("OPFS object store rejects non-canonical content IDs before lookup", async () => {
  const root = new MemoryOpfsDirectory();
  const store = createStore(root);

  await assert.rejects(
    store.read("storage-1", "../object"),
    /Invalid workspace object content ID/,
  );
  assert.equal(root.directoryNames.length, 0);
});

function createStore(root) {
  return new OpfsWorkspaceObjectStore(async () => root);
}

function hasName(name) {
  return (error) => error?.name === name;
}

class MemoryOpfsDirectory {
  #directories = new Map();
  #files = new Map();
  #root;

  constructor(root = null) {
    this.#root = root ?? this;
    if (root === null) {
      this.closeFaults = [];
      this.createWritableCount = 0;
    }
  }

  get directoryNames() {
    return [...this.#directories.keys()].sort();
  }

  async getDirectoryHandle(name, options = {}) {
    assertEntryName(name);
    if (this.#files.has(name)) throw domError("TypeMismatchError");
    const existing = this.#directories.get(name);
    if (existing !== undefined) return existing;
    if (!options.create) throw domError("NotFoundError");

    const directory = new MemoryOpfsDirectory(this.#root);
    this.#directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name, options = {}) {
    assertEntryName(name);
    if (this.#directories.has(name)) throw domError("TypeMismatchError");
    let file = this.#files.get(name);
    if (file === undefined) {
      if (!options.create) throw domError("NotFoundError");
      file = { bytes: new Uint8Array() };
      this.#files.set(name, file);
    }
    return new MemoryOpfsFileHandle(this.#root, file);
  }

  async removeEntry(name, options = {}) {
    assertEntryName(name);
    if (this.#files.delete(name)) return;

    const directory = this.#directories.get(name);
    if (directory === undefined) throw domError("NotFoundError");
    if (
      !options.recursive &&
      (directory.#directories.size > 0 || directory.#files.size > 0)
    ) {
      throw domError("InvalidModificationError");
    }
    this.#directories.delete(name);
  }

  failNextClose(fault) {
    assert.equal(this.#root, this);
    assert.match(fault, /^(before_commit|after_commit)$/);
    this.closeFaults.push(fault);
  }

  replaceFilesNamed(name, bytes) {
    const matches = this.#findFilesNamed(name);
    assert.ok(matches.length > 0, `Expected a file named ${name}`);
    for (const file of matches) file.bytes = bytes.slice();
  }

  bytesForFileNamed(name) {
    const matches = this.#findFilesNamed(name);
    assert.equal(matches.length, 1, `Expected one file named ${name}`);
    return matches[0].bytes.slice();
  }

  #findFilesNamed(name) {
    const matches = [];
    const file = this.#files.get(name);
    if (file !== undefined) matches.push(file);
    for (const directory of this.#directories.values()) {
      matches.push(...directory.#findFilesNamed(name));
    }
    return matches;
  }
}

class MemoryOpfsFileHandle {
  #root;
  #file;

  constructor(root, file) {
    this.#root = root;
    this.#file = file;
  }

  async getFile() {
    const snapshot = this.#file.bytes.slice();
    return {
      async arrayBuffer() {
        return snapshot.buffer;
      },
    };
  }

  async createWritable() {
    this.#root.createWritableCount += 1;
    const root = this.#root;
    const file = this.#file;
    let stagedBytes = new Uint8Array();
    let closed = false;

    return {
      async write(bytes) {
        assert.equal(closed, false);
        stagedBytes = bytes.slice();
      },
      async close() {
        assert.equal(closed, false);
        closed = true;
        const fault = root.closeFaults.shift();
        if (fault === "before_commit") {
          throw new Error("close failed before commit");
        }

        file.bytes = stagedBytes;
        if (fault === "after_commit") {
          throw new Error("close failed after commit");
        }
      },
    };
  }
}

function assertEntryName(name) {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/")) {
    throw new TypeError(`Invalid entry name: ${name}`);
  }
}

function domError(name) {
  return new DOMException(name, name);
}
