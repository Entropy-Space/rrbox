import assert from "node:assert/strict";
import test from "node:test";
import { MemoryFileSystem, VfsError } from "../lib/vfs.ts";

test("lists a deterministic file and directory view", async () => {
  const filesystem = new MemoryFileSystem({
    "/README.md": "hello",
    "/src/index.ts": "export {};",
  });

  assert.deepEqual(await filesystem.list("/"), [
    { name: "src", path: "/src", kind: "directory", size: 0 },
    { name: "README.md", path: "/README.md", kind: "file", size: 5 },
  ]);
});

test("prevents file and directory collisions", () => {
  assert.throws(
    () =>
      new MemoryFileSystem({
        "/src": "file",
        "/src/index.ts": "nested",
      }),
    (error) => error instanceof VfsError && error.code === "not_directory",
  );
});

test("confines paths to the virtual workspace", async () => {
  const filesystem = new MemoryFileSystem();

  await assert.rejects(
    filesystem.write("../../outside.txt", "nope"),
    (error) => error instanceof VfsError && error.code === "invalid_path",
  );
});

test("reads and overwrites text files", async () => {
  const filesystem = new MemoryFileSystem();
  await filesystem.write("/notes/today.md", "first");
  await filesystem.write("/notes/today.md", "second");

  assert.equal(await filesystem.read("/notes/today.md"), "second");
});
