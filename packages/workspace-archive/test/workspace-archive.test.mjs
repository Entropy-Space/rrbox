import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MemoryWorkspace,
  VfsError,
  compareVfsStrings,
} from "@researchbox/vfs";
import { deflateSync } from "fflate";
import {
  DEFAULT_WORKSPACE_ARCHIVE_LIMITS,
  WORKSPACE_ARCHIVE_FORMAT_VERSION,
  WORKSPACE_ARCHIVE_MANIFEST_PATH,
  WorkspaceArchiveError,
  capturePortableWorkspace,
  decodeWorkspaceArchive,
  encodeWorkspaceArchive,
  exportWorkspaceArchive,
  normalizePortableWorkspaceSnapshot,
} from "../src/index.ts";
import { canonicalZipByteSize } from "../src/zip-layout.ts";
import { utf8ByteLengthOfWellFormedString } from "../src/paths.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("exports byte-identical canonical archives from equivalent snapshots", () => {
  const first = encodeWorkspaceArchive({
    files: [
      { path: "/z.txt", content: "last" },
      { path: "/a/é.txt", content: "first\n" },
    ],
  });
  const second = encodeWorkspaceArchive({
    files: [
      { path: "/a/é.txt", content: "first\n" },
      { path: "/z.txt", content: "last" },
    ],
  });

  assert.deepEqual(first, second);
  const localEntries = inspectLocalEntries(first);
  assert.deepEqual(
    localEntries.map((entry) => entry.name),
    [
      WORKSPACE_ARCHIVE_MANIFEST_PATH,
      "workspace/a/é.txt",
      "workspace/z.txt",
    ],
  );
  for (const entry of localEntries) {
    assert.equal(entry.method, 0);
    assert.equal(entry.flags & 0x0008, 0);
    assert.equal(entry.dos_time, 0);
    assert.equal(entry.dos_date, 0x21);
  }
  const centralEntries = inspectCentralEntries(first);
  assert.deepEqual(
    centralEntries.map((entry) => entry.name),
    localEntries.map((entry) => entry.name),
  );
  for (const entry of centralEntries) {
    assert.equal(entry.made_by_system, 0);
    assert.equal(entry.method, 0);
    assert.equal(entry.dos_time, 0);
    assert.equal(entry.dos_date, 0x21);
    assert.equal(entry.extra_byte_size, 0);
    assert.equal(entry.comment_byte_size, 0);
    assert.equal(entry.internal_attrs, 0);
    assert.equal(entry.external_attrs, 0);
  }

  const manifest = decoder.decode(localEntries[0].content);
  assert.equal(manifest.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(manifest), {
    format: "researchbox_workspace",
    format_version: WORKSPACE_ARCHIVE_FORMAT_VERSION,
    content_encoding: "utf-8",
    files: [
      {
        path: "/a/é.txt",
        archive_path: "workspace/a/é.txt",
        byte_size: 6,
        sha256:
          "b640e840b19d378660b32fb51ae18d67dccb4a8596a29e7bd72c1b2ae5928f41",
      },
      {
        path: "/z.txt",
        archive_path: "workspace/z.txt",
        byte_size: 4,
        sha256:
          "3547cb112ac4489af2310c0626cdba6f3097a2ad5a3b42ddd3b59c76c7a079a3",
      },
    ],
  });
});

test("round-trips UTF-8 text and preserves distinct Unicode spellings", () => {
  const snapshot = {
    files: [
      { path: "/__proto__", content: "prototype-safe" },
      { path: "/bom.txt", content: "\uFEFFa" },
      { path: "/Case.txt", content: "upper" },
      { path: "/case.txt", content: "lower" },
      { path: "/empty.txt", content: "" },
      { path: "/café.txt", content: "composed ☕" },
      { path: "/café.txt", content: "decomposed\n第二行" },
      { path: "/emoji/🧪.txt", content: "non-BMP 😀" },
    ],
  };

  const archive = encodeWorkspaceArchive(snapshot);
  assert.deepEqual(
    decodeWorkspaceArchive(
      archive.buffer.slice(
        archive.byteOffset,
        archive.byteOffset + archive.byteLength,
      ),
    ),
    {
      files: snapshot.files
        .slice()
        .sort((left, right) => compareVfsStrings(left.path, right.path)),
    },
  );
});

test("normalizes portable snapshots without exposing ZIP internals", () => {
  const source = {
    files: [
      { path: "/z.txt", content: "last" },
      { path: "/a.txt", content: "first" },
    ],
  };

  const normalized = normalizePortableWorkspaceSnapshot(source);
  assert.deepEqual(normalized, {
    files: [
      { path: "/a.txt", content: "first" },
      { path: "/z.txt", content: "last" },
    ],
  });
  assert.notEqual(normalized.files, source.files);
  assert.notEqual(normalized.files[0], source.files[1]);
  assert.throws(
    () =>
      normalizePortableWorkspaceSnapshot({
        files: [
          { path: "/a", content: "file" },
          { path: "/a/b.txt", content: "child" },
        ],
      }),
    archiveError("invalid_input"),
  );
});

test("matches fixed SHA-256, CRC-32, and empty-archive byte vectors", () => {
  const emptyArchive = encodeWorkspaceArchive({ files: [] });
  assert.equal(
    Buffer.from(emptyArchive).toString("base64"),
    "UEsDBBQAAAAAAAAAIQBDoByZbQAAAG0AAAAaAAAAcmVzZWFyY2hib3gtd29ya3NwYWNlLmpzb257CiAgImZvcm1hdCI6ICJyZXNlYXJjaGJveF93b3Jrc3BhY2UiLAogICJmb3JtYXRfdmVyc2lvbiI6IDEsCiAgImNvbnRlbnRfZW5jb2RpbmciOiAidXRmLTgiLAogICJmaWxlcyI6IFtdCn0KUEsBAhQAFAAAAAAAAAAhAEOgHJltAAAAbQAAABoAAAAAAAAAAAAAAAAAAAAAAHJlc2VhcmNoYm94LXdvcmtzcGFjZS5qc29uUEsFBgAAAAABAAEASAAAAKUAAAAAAA==",
  );

  const vectorArchive = encodeWorkspaceArchive({
    files: [{ path: "/vector.txt", content: "123456789" }],
  });
  const entries = inspectLocalEntries(vectorArchive);
  assert.equal(entries[1].crc32, 0xcbf43926);
  assert.equal(
    JSON.parse(decoder.decode(entries[0].content)).files[0].sha256,
    "15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225",
  );
});

test("captures a stable revision and exports content without journal history", async () => {
  const workspace = new MemoryWorkspace({
    "/README.md": "seed",
    "/src/index.ts": "export {};",
  });
  await workspace.write("/README.md", "updated", {
    change: {
      change_id: "change-1",
      session_id: "session-1",
      tool_call_block_id: "block-1",
      assistant_message_index: 0,
      tool_call_id: "call-1",
      tool_name: "write_file",
      created_at: "2026-07-24T00:00:00.000Z",
    },
  });

  const result = await exportWorkspaceArchive(workspace);
  assert.equal(result.workspace_revision, 1);
  assert.equal(result.file_count, 2);
  assert.equal(result.content_byte_size, 17);
  assert.deepEqual(decodeWorkspaceArchive(result.archive_bytes), {
    files: [
      { path: "/README.md", content: "updated" },
      { path: "/src/index.ts", content: "export {};" },
    ],
  });
  assert.equal(
    decoder.decode(result.archive_bytes).includes("change-1"),
    false,
  );
});

test("retries capture when the workspace revision changes", async () => {
  const workspace = new MemoryWorkspace({ "/a.txt": "a" });
  let mutateOnRead = true;
  const reader = {
    list: (path) => workspace.list(path),
    async read(path) {
      if (mutateOnRead) {
        mutateOnRead = false;
        await workspace.write("/b.txt", "b");
      }
      return workspace.read(path);
    },
  };

  assert.deepEqual(await capturePortableWorkspace(reader), {
    snapshot: {
      files: [
        { path: "/a.txt", content: "a" },
        { path: "/b.txt", content: "b" },
      ],
    },
    workspace_revision: 1,
  });
});

test("prefers a revision-stable bulk workspace snapshot", async () => {
  let listCalls = 0;
  let readCalls = 0;
  const sourceFiles = [
    { path: "/z.txt", content: "last" },
    { path: "/a.txt", content: "first" },
  ];
  const reader = {
    async list() {
      listCalls += 1;
      throw new Error("The bulk snapshot should replace directory traversal.");
    },
    async read() {
      readCalls += 1;
      throw new Error("The bulk snapshot should replace individual reads.");
    },
    async readFilesSnapshot() {
      return {
        workspace_revision: 7,
        files: sourceFiles,
      };
    },
  };

  const captured = await capturePortableWorkspace(reader);
  sourceFiles[0].content = "mutated after capture";

  assert.deepEqual(captured, {
    snapshot: {
      files: [
        { path: "/a.txt", content: "first" },
        { path: "/z.txt", content: "last" },
      ],
    },
    workspace_revision: 7,
  });
  assert.equal(listCalls, 0);
  assert.equal(readCalls, 0);
});

test("propagates capture cancellation to the bulk snapshot reader", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const reader = {
    async list() {
      throw new Error("Unexpected list");
    },
    async read() {
      throw new Error("Unexpected read");
    },
    readFilesSnapshot(options) {
      receivedSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      });
    },
  };
  const capture = capturePortableWorkspace(
    reader,
    undefined,
    controller.signal,
  );
  controller.abort(new DOMException("Canceled by the caller.", "AbortError"));

  await assert.rejects(
    capture,
    (error) => error?.name === "AbortError",
  );
  assert.equal(receivedSignal, controller.signal);
});

test("retries capture when a concurrent shape change makes a read fail", async () => {
  const workspace = new MemoryWorkspace({ "/a.txt": "a" });
  let mutateOnRead = true;
  const reader = {
    list: (path) => workspace.list(path),
    async read(path) {
      if (mutateOnRead) {
        mutateOnRead = false;
        await workspace.remove("/a.txt");
        await workspace.write("/b.txt", "b");
      }
      return workspace.read(path);
    },
  };

  assert.deepEqual(await capturePortableWorkspace(reader), {
    snapshot: {
      files: [{ path: "/b.txt", content: "b" }],
    },
    workspace_revision: 2,
  });
});

test("fails capture after bounded concurrent changes", async () => {
  const workspace = new MemoryWorkspace({ "/a.txt": "0" });
  let revision = 0;
  const reader = {
    list: (path) => workspace.list(path),
    async read(path) {
      revision += 1;
      await workspace.write("/a.txt", String(revision));
      return workspace.read(path);
    },
  };

  await assert.rejects(
    capturePortableWorkspace(reader),
    archiveError("workspace_changed"),
  );
  assert.equal(revision, 3);
});

test("turns a concurrently deleted workspace into a bounded capture failure", async () => {
  let deleted = false;
  const reader = {
    async list() {
      if (deleted) {
        throw new VfsError("not_found", "Workspace was deleted.");
      }
      return {
        workspace_revision: 0,
        entries: [
          {
            name: "a.txt",
            path: "/a.txt",
            kind: "file",
            size: 1,
          },
        ],
      };
    },
    async read() {
      deleted = true;
      throw new VfsError("not_found", "File was deleted.");
    },
  };

  await assert.rejects(
    capturePortableWorkspace(reader),
    archiveError("workspace_changed"),
  );
});

test("rejects an oversized listing before reading file content", async () => {
  let readCalls = 0;
  const reader = {
    async list() {
      return {
        workspace_revision: 0,
        entries: [
          {
            name: "large.txt",
            path: "/large.txt",
            kind: "file",
            size: DEFAULT_WORKSPACE_ARCHIVE_LIMITS.max_file_bytes + 1,
          },
        ],
      };
    },
    async read() {
      readCalls += 1;
      return {
        workspace_revision: 0,
        content: "",
      };
    },
  };

  await assert.rejects(
    capturePortableWorkspace(reader),
    archiveError("limit_exceeded"),
  );
  assert.equal(readCalls, 0);
});

test("rejects noncanonical snapshots and file-directory collisions", () => {
  const invalidSnapshots = [
    { files: [{ path: "relative.txt", content: "x" }] },
    { files: [{ path: "/a/../b.txt", content: "x" }] },
    { files: [{ path: "/a\\b.txt", content: "x" }] },
    { files: [{ path: "/bad.txt", content: "\ud800" }] },
    {
      files: [
        { path: "/a", content: "file" },
        { path: "/a/b.txt", content: "child" },
      ],
    },
    {
      files: [
        { path: "/same.txt", content: "first" },
        { path: "/same.txt", content: "second" },
      ],
    },
  ];

  for (const snapshot of invalidSnapshots) {
    assert.throws(
      () => encodeWorkspaceArchive(snapshot),
      archiveError("invalid_input"),
    );
  }
});

test("enforces encode limits before and after ZIP construction", () => {
  assert.throws(
    () =>
      encodeWorkspaceArchive(
        { files: [{ path: "/a.txt", content: "ab" }] },
        { limits: { max_file_bytes: 1 } },
      ),
    archiveError("limit_exceeded"),
  );
  assert.throws(
    () =>
      encodeWorkspaceArchive(
        {
          files: [
            { path: "/a.txt", content: "a" },
            { path: "/b.txt", content: "b" },
          ],
        },
        { limits: { max_files: 1 } },
      ),
    archiveError("limit_exceeded"),
  );
  assert.throws(
    () =>
      encodeWorkspaceArchive(
        { files: [{ path: "/a/b.txt", content: "x" }] },
        { limits: { max_path_depth: 1 } },
      ),
    archiveError("limit_exceeded"),
  );
  assert.throws(
    () =>
      encodeWorkspaceArchive(
        { files: [] },
        { limits: { max_manifest_bytes: 1 } },
      ),
    archiveError("limit_exceeded"),
  );
  assert.throws(
    () =>
      encodeWorkspaceArchive(
        { files: [] },
        { limits: { max_archive_bytes: 1 } },
      ),
    archiveError("limit_exceeded"),
  );
});

test("rejects otherwise valid DEFLATE payloads in strict v1", () => {
  const archive = buildWorkspaceArchive([
    { path: "/large.txt", content: "abc".repeat(10_000), method: 8 },
  ]);

  assert.throws(
    () => decodeWorkspaceArchive(archive),
    archiveError("unsupported_format"),
  );
});

test("rejects extra, missing, duplicate, and directory ZIP entries", () => {
  const validFile = { path: "/a.txt", content: "a" };
  const manifest = createManifest([validFile]);
  const cases = [
    [
      storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
      storedEntry("workspace/a.txt", encoder.encode("a")),
      storedEntry("workspace/extra.txt", encoder.encode("extra")),
    ],
    [storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest))],
    [
      storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
      storedEntry("workspace/a.txt", encoder.encode("a")),
      storedEntry("workspace/a.txt", encoder.encode("a")),
    ],
    [
      storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
      {
        ...storedEntry("workspace/a.txt", encoder.encode("a")),
        external_attrs: 0x10,
      },
    ],
  ];

  for (const entries of cases) {
    assert.throws(
      () => decodeWorkspaceArchive(buildZip(entries)),
      archiveError("invalid_archive"),
    );
  }
});

test("rejects unsafe and aliased ZIP entry names", () => {
  const manifest = createManifest([{ path: "/a.txt", content: "a" }]);
  for (const name of [
    "../workspace/a.txt",
    "workspace\\a.txt",
    "/workspace/a.txt",
    "workspace//a.txt",
    "workspace/\0a.txt",
  ]) {
    assert.throws(
      () =>
        decodeWorkspaceArchive(
          buildZip([
            storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
            storedEntry(name, encoder.encode("a")),
          ]),
        ),
      archiveError("invalid_archive"),
    );
  }

  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
          {
            ...storedEntry("workspace/a.txt", encoder.encode("a")),
            local_name: "workspace/b.txt",
          },
        ]),
      ),
    archiveError("invalid_archive"),
  );
});

test("rejects unsupported ZIP features before extracting content", () => {
  const manifestBytes = jsonBytes(createManifest([]));
  const cases = [
    [{ ...storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, manifestBytes), flags: 1 }],
    [
      {
        ...storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, manifestBytes),
        flags: 0x0008,
      },
    ],
    [
      {
        ...storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, manifestBytes),
        method: 12,
      },
    ],
  ];

  for (const entries of cases) {
    assert.throws(
      () => decodeWorkspaceArchive(buildZip(entries)),
      archiveError("unsupported_format"),
    );
  }

  const zip64 = buildZip([
    storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, manifestBytes),
  ]);
  writeU16(zip64, zip64.byteLength - 14, 0xffff);
  writeU16(zip64, zip64.byteLength - 12, 0xffff);
  assert.throws(
    () => decodeWorkspaceArchive(zip64),
    archiveError("unsupported_format"),
  );

  const zip64Extra = buildZip([
    {
      ...storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, manifestBytes),
      central_extra: new Uint8Array([0x01, 0x00, 0x00, 0x00]),
    },
  ]);
  assert.throws(
    () => decodeWorkspaceArchive(zip64Extra),
    archiveError("unsupported_format"),
  );

  const zip32 = buildZip([
    storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, manifestBytes),
  ]);
  const eocdOffset = zip32.byteLength - 22;
  const centralOffset = readU32(zip32, eocdOffset + 16);
  for (const offset of [
    centralOffset + 20,
    centralOffset + 24,
    centralOffset + 42,
    eocdOffset + 12,
    eocdOffset + 16,
  ]) {
    const sentinel = zip32.slice();
    writeU32(sentinel, offset, 0xffffffff);
    assert.throws(
      () => decodeWorkspaceArchive(sentinel),
      archiveError("unsupported_format"),
    );
  }

  const reservedCount = zip32.slice();
  writeU16(reservedCount, eocdOffset + 8, 0xfffe);
  writeU16(reservedCount, eocdOffset + 10, 0xfffe);
  assert.throws(
    () =>
      decodeWorkspaceArchive(reservedCount, {
        limits: { max_files: 0xfffe - 1 },
      }),
    archiveError("invalid_archive"),
  );
});

test("rejects ZIP extras, comments, and nonzero file attributes", () => {
  const manifestEntry = storedEntry(
    WORKSPACE_ARCHIVE_MANIFEST_PATH,
    jsonBytes(createManifest([])),
  );
  const invalidEntries = [
    {
      ...manifestEntry,
      local_extra: new Uint8Array([0xfe, 0xca, 0x00, 0x00]),
    },
    {
      ...manifestEntry,
      central_extra: new Uint8Array([0xfe, 0xca, 0x00, 0x00]),
    },
    {
      ...manifestEntry,
      central_comment: encoder.encode("comment"),
    },
    {
      ...manifestEntry,
      internal_attrs: 1,
    },
    {
      ...manifestEntry,
      external_attrs: 0xa0000000,
    },
  ];

  for (const entry of invalidEntries) {
    assert.throws(
      () => decodeWorkspaceArchive(buildZip([entry])),
      archiveError("invalid_archive"),
    );
  }
  assert.throws(
    () =>
      decodeWorkspaceArchive(
        addArchiveComment(buildZip([manifestEntry]), encoder.encode("comment")),
      ),
    archiveError("invalid_archive"),
  );
});

test("requires a stored manifest as the first local entry", () => {
  const manifest = createManifest([{ path: "/a.txt", content: "a" }]);
  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          storedEntry("workspace/a.txt", encoder.encode("a")),
          storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
        ]),
      ),
    archiveError("invalid_archive"),
  );
  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          {
            ...storedEntry(
              WORKSPACE_ARCHIVE_MANIFEST_PATH,
              jsonBytes(createManifest([])),
            ),
            method: 8,
          },
        ]),
      ),
    archiveError("unsupported_format"),
  );
});

test("rejects every security-relevant local and central header mismatch", () => {
  const manifestEntry = storedEntry(
    WORKSPACE_ARCHIVE_MANIFEST_PATH,
    jsonBytes(createManifest([])),
  );
  const mismatches = [
    { local_flags: 0x0800 },
    { local_method: 8 },
    { local_crc32: 0 },
    { local_compressed_size: 0 },
    { local_uncompressed_size: 0 },
  ];

  for (const mismatch of mismatches) {
    assert.throws(
      () =>
        decodeWorkspaceArchive(
          buildZip([{ ...manifestEntry, ...mismatch }]),
        ),
      archiveError("invalid_archive"),
    );
  }
});

test("rejects malformed or unsupported manifest schemas", () => {
  const base = createManifest([]);
  const invalidCases = [
    { ...base, extra: true },
    { ...base, files: "nope" },
    {
      ...base,
      files: [
        {
          path: "/a.txt",
          archive_path: "workspace/a.txt",
          byte_size: 0,
          sha256: "A".repeat(64),
        },
      ],
    },
  ];
  for (const manifest of invalidCases) {
    assert.throws(
      () =>
        decodeWorkspaceArchive(
          buildZip([
            storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
          ]),
        ),
      archiveError("invalid_archive"),
    );
  }

  for (const manifest of [
    { ...base, format: "other" },
    { ...base, format_version: 2 },
    { ...base, content_encoding: "utf-16" },
  ]) {
    assert.throws(
      () =>
        decodeWorkspaceArchive(
          buildZip([
            storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
          ]),
        ),
      archiveError("unsupported_format"),
    );
  }
});

test("rejects duplicate manifest keys, including escaped aliases", () => {
  const emptyManifestSource = decoder.decode(jsonBytes(createManifest([])));
  const duplicateRootSource = emptyManifestSource.replace(
    '  "format": "researchbox_workspace",',
    '  "format": "researchbox_workspace",\n  "f\\u006frmat": "researchbox_workspace",',
  );
  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          storedEntry(
            WORKSPACE_ARCHIVE_MANIFEST_PATH,
            encoder.encode(duplicateRootSource),
          ),
        ]),
      ),
    archiveError("invalid_archive"),
  );

  const file = { path: "/a.txt", content: "" };
  const fileManifestSource = decoder.decode(
    jsonBytes(createManifest([file])),
  );
  const duplicateFileSource = fileManifestSource.replace(
    '      "path": "/a.txt",',
    '      "path": "/a.txt",\n      "pa\\u0074h": "/a.txt",',
  );
  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          storedEntry(
            WORKSPACE_ARCHIVE_MANIFEST_PATH,
            encoder.encode(duplicateFileSource),
          ),
          storedEntry("workspace/a.txt", new Uint8Array()),
        ]),
      ),
    archiveError("invalid_archive"),
  );
});

test("rejects manifest path mismatches, duplicates, and collisions", () => {
  const emptyHash = sha256(new Uint8Array());
  const manifests = [
    {
      ...createManifest([]),
      files: [
        {
          path: "relative.txt",
          archive_path: "workspace/relative.txt",
          byte_size: 0,
          sha256: emptyHash,
        },
      ],
    },
    {
      ...createManifest([]),
      files: [
        {
          path: "/a.txt",
          archive_path: "workspace/b.txt",
          byte_size: 0,
          sha256: emptyHash,
        },
      ],
    },
    {
      ...createManifest([]),
      files: [
        {
          path: "/a",
          archive_path: "workspace/a",
          byte_size: 0,
          sha256: emptyHash,
        },
        {
          path: "/a/b",
          archive_path: "workspace/a/b",
          byte_size: 0,
          sha256: emptyHash,
        },
      ],
    },
  ];

  for (const manifest of manifests) {
    const payloads = manifest.files.map((file) =>
      storedEntry(file.archive_path, new Uint8Array()),
    );
    assert.throws(
      () =>
        decodeWorkspaceArchive(
          buildZip([
            storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
            ...payloads,
          ]),
        ),
      archiveError("invalid_archive"),
    );
  }
});

test("verifies declared sizes, CRC-32, SHA-256, and UTF-8", () => {
  const valid = { path: "/a.txt", content: "a" };
  const manifest = createManifest([valid]);

  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
          {
            ...storedEntry("workspace/a.txt", encoder.encode("a")),
            crc32: 0,
          },
        ]),
      ),
    archiveError("invalid_archive"),
  );

  const wrongHash = structuredClone(manifest);
  wrongHash.files[0].sha256 = "0".repeat(64);
  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(wrongHash)),
          storedEntry("workspace/a.txt", encoder.encode("a")),
        ]),
      ),
    archiveError("invalid_archive"),
  );

  const wrongSize = structuredClone(manifest);
  wrongSize.files[0].byte_size = 2;
  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(wrongSize)),
          storedEntry("workspace/a.txt", encoder.encode("a")),
        ]),
      ),
    archiveError("invalid_archive"),
  );

  const invalidUtf8 = new Uint8Array([0xff]);
  const invalidUtf8Manifest = {
    ...createManifest([]),
    files: [
      {
        path: "/a.txt",
        archive_path: "workspace/a.txt",
        byte_size: 1,
        sha256: sha256(invalidUtf8),
      },
    ],
  };
  assert.throws(
    () =>
      decodeWorkspaceArchive(
        buildZip([
          storedEntry(
            WORKSPACE_ARCHIVE_MANIFEST_PATH,
            jsonBytes(invalidUtf8Manifest),
          ),
          storedEntry("workspace/a.txt", invalidUtf8),
        ]),
      ),
    archiveError("invalid_archive"),
  );
});

test("enforces decode limits from central-directory declarations", () => {
  const archive = buildWorkspaceArchive([
    { path: "/a.txt", content: "ab" },
    { path: "/b.txt", content: "cd" },
  ]);
  const cases = [
    { max_archive_bytes: archive.byteLength - 1 },
    { max_manifest_bytes: 1 },
    { max_files: 1 },
    { max_file_bytes: 1 },
    { max_total_content_bytes: 3 },
    { max_path_bytes: 5 },
    { max_path_depth: 0 },
  ];

  for (const limits of cases) {
    assert.throws(
      () => decodeWorkspaceArchive(archive, { limits }),
      archiveError("limit_exceeded"),
    );
  }
});

test("rejects untracked prefixes, gaps, and trailing local data", () => {
  const valid = buildWorkspaceArchive([]);
  assert.throws(
    () => decodeWorkspaceArchive(valid.subarray(0, valid.byteLength - 1)),
    archiveError("invalid_archive"),
  );
  const prefixed = concatBytes([new Uint8Array([0]), valid]);
  assert.throws(
    () => decodeWorkspaceArchive(prefixed),
    archiveError("invalid_archive"),
  );

  const withGap = valid.slice();
  const eocd = withGap.byteLength - 22;
  const centralOffset = readU32(withGap, eocd + 16);
  writeU32(withGap, eocd + 16, centralOffset - 1);
  writeU32(withGap, eocd + 12, readU32(withGap, eocd + 12) + 1);
  assert.throws(
    () => decodeWorkspaceArchive(withGap),
    archiveError("invalid_archive"),
  );
});

test("default limits are immutable and option values must be safe integers", () => {
  assert.equal(Object.isFrozen(DEFAULT_WORKSPACE_ARCHIVE_LIMITS), true);
  assert.throws(
    () =>
      encodeWorkspaceArchive(
        { files: [] },
        { limits: { max_files: Number.NaN } },
      ),
    archiveError("invalid_input"),
  );
  assert.throws(
    () =>
      encodeWorkspaceArchive(
        { files: [] },
        { limits: { max_files: -1 } },
      ),
    archiveError("invalid_input"),
  );
  assert.throws(
    () =>
      encodeWorkspaceArchive(
        { files: [] },
        { limits: { max_filse: 1 } },
      ),
    archiveError("invalid_input"),
  );
});

test("computes exact UTF-8 sizes without allocating encoded content", () => {
  assert.equal(utf8ByteLengthOfWellFormedString("ASCII"), 5);
  assert.equal(utf8ByteLengthOfWellFormedString("é"), 2);
  assert.equal(utf8ByteLengthOfWellFormedString("第二行"), 9);
  assert.equal(utf8ByteLengthOfWellFormedString("🧪"), 4);
  assert.equal(utf8ByteLengthOfWellFormedString("\uFEFFa"), 4);
});

test("rejects every ZIP16 and ZIP32 reserved-sentinel boundary", () => {
  const minimalEntry = {
    name_byte_size: 1,
    content_byte_size: 0,
  };
  assert.throws(
    () => canonicalZipByteSize(Array(0xffff).fill(minimalEntry)),
    archiveError("invalid_input"),
  );
  assert.throws(
    () =>
      canonicalZipByteSize([
        {
          name_byte_size: 1,
          content_byte_size: 0xffffffff,
        },
      ]),
    archiveError("invalid_input"),
  );
  assert.throws(
    () =>
      canonicalZipByteSize([
        {
          name_byte_size: 1,
          content_byte_size: 0xffffffff - 31,
        },
      ]),
    archiveError("invalid_input"),
  );
  assert.throws(
    () =>
      canonicalZipByteSize(
        Array(65_492).fill({
          name_byte_size: 0xffff,
          content_byte_size: 0,
        }),
      ),
    archiveError("invalid_input"),
  );
  assert.throws(
    () =>
      canonicalZipByteSize(
        Array(0xffff - 1).fill({
          name_byte_size: 32_740,
          content_byte_size: 0,
        }),
      ),
    archiveError("invalid_input"),
  );
});

function buildWorkspaceArchive(files) {
  const manifest = createManifest(files);
  return buildZip([
    storedEntry(WORKSPACE_ARCHIVE_MANIFEST_PATH, jsonBytes(manifest)),
    ...files.map((file) => ({
      ...storedEntry(`workspace/${file.path.slice(1)}`, encoder.encode(file.content)),
      method: file.method ?? 0,
    })),
  ]);
}

function createManifest(files) {
  return {
    format: "researchbox_workspace",
    format_version: 1,
    content_encoding: "utf-8",
    files: files
      .map((file) => {
        const bytes = encoder.encode(file.content);
        return {
          path: file.path,
          archive_path: `workspace/${file.path.slice(1)}`,
          byte_size: bytes.byteLength,
          sha256: sha256(bytes),
        };
      })
      .sort((left, right) => compareVfsStrings(left.path, right.path)),
  };
}

function jsonBytes(value) {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function storedEntry(name, content) {
  return { name, content, method: 0 };
}

function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const specification of entries) {
    const centralName = encoder.encode(specification.name);
    const localName = encoder.encode(specification.local_name ?? specification.name);
    const localExtra = specification.local_extra ?? new Uint8Array();
    const centralExtra = specification.central_extra ?? new Uint8Array();
    const centralComment = specification.central_comment ?? new Uint8Array();
    const content = specification.content;
    const method = specification.method ?? 0;
    const compressed =
      specification.compressed ??
      (method === 8 ? deflateSync(content) : content);
    const flags =
      specification.flags ??
      (centralName.some((byte) => byte > 0x7f) ? 0x0800 : 0);
    const checksum = specification.crc32 ?? crc32(content);
    const compressedSize =
      specification.compressed_size ?? compressed.byteLength;
    const uncompressedSize =
      specification.uncompressed_size ?? content.byteLength;

    const local = new Uint8Array(
      30 + localName.byteLength + localExtra.byteLength,
    );
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 6, specification.local_flags ?? flags);
    writeU16(local, 8, specification.local_method ?? method);
    writeU16(local, 10, 0);
    writeU16(local, 12, 0x21);
    writeU32(local, 14, specification.local_crc32 ?? checksum);
    writeU32(
      local,
      18,
      specification.local_compressed_size ?? compressedSize,
    );
    writeU32(
      local,
      22,
      specification.local_uncompressed_size ?? uncompressedSize,
    );
    writeU16(local, 26, localName.byteLength);
    writeU16(local, 28, localExtra.byteLength);
    local.set(localName, 30);
    local.set(localExtra, 30 + localName.byteLength);
    localChunks.push(local, compressed);

    const central = new Uint8Array(
      46 +
        centralName.byteLength +
        centralExtra.byteLength +
        centralComment.byteLength,
    );
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 4, 20);
    writeU16(central, 6, 20);
    writeU16(central, 8, flags);
    writeU16(central, 10, method);
    writeU16(central, 12, 0);
    writeU16(central, 14, 0x21);
    writeU32(central, 16, checksum);
    writeU32(central, 20, compressedSize);
    writeU32(central, 24, uncompressedSize);
    writeU16(central, 28, centralName.byteLength);
    writeU16(central, 30, centralExtra.byteLength);
    writeU16(central, 32, centralComment.byteLength);
    writeU16(central, 34, 0);
    writeU16(central, 36, specification.internal_attrs ?? 0);
    writeU32(central, 38, specification.external_attrs ?? 0);
    writeU32(central, 42, localOffset);
    central.set(centralName, 46);
    central.set(centralExtra, 46 + centralName.byteLength);
    central.set(
      centralComment,
      46 + centralName.byteLength + centralExtra.byteLength,
    );
    centralChunks.push(central);
    localOffset += local.byteLength + compressed.byteLength;
  }

  const centralSize = centralChunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 8, entries.length);
  writeU16(end, 10, entries.length);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, localOffset);
  return concatBytes([...localChunks, ...centralChunks, end]);
}

function inspectLocalEntries(bytes) {
  const eocd = bytes.byteLength - 22;
  const centralOffset = readU32(bytes, eocd + 16);
  const entries = [];
  let offset = 0;
  while (offset < centralOffset) {
    assert.equal(readU32(bytes, offset), 0x04034b50);
    const flags = readU16(bytes, offset + 6);
    const method = readU16(bytes, offset + 8);
    const dosTime = readU16(bytes, offset + 10);
    const dosDate = readU16(bytes, offset + 12);
    const compressedSize = readU32(bytes, offset + 18);
    const checksum = readU32(bytes, offset + 14);
    const nameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const nameOffset = offset + 30;
    const dataOffset = nameOffset + nameLength + extraLength;
    entries.push({
      name: decoder.decode(bytes.subarray(nameOffset, nameOffset + nameLength)),
      flags,
      method,
      dos_time: dosTime,
      dos_date: dosDate,
      crc32: checksum,
      content: bytes.slice(dataOffset, dataOffset + compressedSize),
    });
    offset = dataOffset + compressedSize;
  }
  return entries;
}

function inspectCentralEntries(bytes) {
  const eocd = bytes.byteLength - 22;
  const entryCount = readU16(bytes, eocd + 10);
  let offset = readU32(bytes, eocd + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(readU32(bytes, offset), 0x02014b50);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      made_by_system: bytes[offset + 5],
      method: readU16(bytes, offset + 10),
      dos_time: readU16(bytes, offset + 12),
      dos_date: readU16(bytes, offset + 14),
      extra_byte_size: extraLength,
      comment_byte_size: commentLength,
      internal_attrs: readU16(bytes, offset + 36),
      external_attrs: readU32(bytes, offset + 38),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, eocd);
  return entries;
}

function addArchiveComment(archive, comment) {
  const result = new Uint8Array(archive.byteLength + comment.byteLength);
  result.set(archive);
  result.set(comment, archive.byteLength);
  writeU16(result, archive.byteLength - 2, comment.byteLength);
  return result;
}

function archiveError(code) {
  return (error) =>
    error instanceof WorkspaceArchiveError && error.code === code;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) === 1
          ? (value >>> 1) ^ 0xedb88320
          : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks) {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
