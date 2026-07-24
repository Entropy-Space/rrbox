import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVE_WORKER_PROTOCOL_VERSION,
  ArchiveWorkerProtocolError,
  createDecodeWorkspaceArchiveRequest,
  createEncodeWorkspaceArchiveRequest,
  parseArchiveWorkerRequest,
  parseArchiveWorkerResponse,
} from "../browser/archive-worker-protocol.ts";

test("creates exact encode and transferable decode requests", () => {
  const archiveBytes = new ArrayBuffer(4);
  const decode = createDecodeWorkspaceArchiveRequest(archiveBytes);
  const encode = createEncodeWorkspaceArchiveRequest([
    { path: "README.md", content: "# Workspace" },
  ]);

  assert.deepEqual(Object.keys(decode), [
    "protocol_version",
    "type",
    "archive_bytes",
  ]);
  assert.equal(decode.archive_bytes, archiveBytes);
  assert.deepEqual(encode, {
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "encode_workspace_archive",
    files: [{ path: "README.md", content: "# Workspace" }],
  });
  assert.equal(parseArchiveWorkerRequest(decode), decode);
  assert.equal(parseArchiveWorkerRequest(encode), encode);
});

test("rejects malformed archive worker requests", () => {
  const invalidRequests = [
    null,
    {},
    {
      protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
      type: "decode_workspace_archive",
      archive_bytes: new Uint8Array(1),
    },
    {
      protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
      type: "decode_workspace_archive",
      archive_bytes: new ArrayBuffer(1),
      extra: true,
    },
    {
      protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
      type: "encode_workspace_archive",
      files: null,
    },
    {
      protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
      type: "encode_workspace_archive",
      files: [{ path: "README.md", content: 42 }],
    },
    {
      protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
      type: "encode_workspace_archive",
      files: [{ path: "README.md", content: "", extra: true }],
    },
    {
      protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION + 1,
      type: "encode_workspace_archive",
      files: [],
    },
    {
      protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
      type: "unknown",
      files: [],
    },
  ];

  for (const request of invalidRequests) {
    assert.throws(
      () => parseArchiveWorkerRequest(request),
      ArchiveWorkerProtocolError,
    );
  }
});

test("validates success and error responses with exact snake_case fields", () => {
  const decoded = {
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "workspace_archive_decoded",
    files: [{ path: "src/index.ts", content: "export {};" }],
  };
  const encoded = {
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "workspace_archive_encoded",
    archive_bytes: new ArrayBuffer(8),
  };
  const failure = {
    protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
    type: "workspace_archive_error",
    error_code: "invalid_archive",
    error_message: "The archive is invalid.",
  };

  assert.equal(parseArchiveWorkerResponse(decoded), decoded);
  assert.equal(parseArchiveWorkerResponse(encoded), encoded);
  assert.equal(parseArchiveWorkerResponse(failure), failure);

  for (const response of [
    { ...decoded, files: [{ path: "README.md" }] },
    { ...encoded, archive_bytes: new Uint8Array(8) },
    { ...failure, error_code: "surprise" },
    { ...failure, error_message: "" },
    { ...failure, extra: true },
  ]) {
    assert.throws(
      () => parseArchiveWorkerResponse(response),
      ArchiveWorkerProtocolError,
    );
  }
});

test("copies outbound file records before posting them to a worker", () => {
  const file = { path: "notes.txt", content: "before" };
  const request = createEncodeWorkspaceArchiveRequest([file]);

  file.content = "after";

  assert.equal(request.files[0].content, "before");
  assert.notEqual(request.files[0], file);
});
