import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryWorkspace,
  VfsError,
} from "@researchbox/vfs";
import {
  searchWorkspaceText,
} from "../src/index.ts";

test("searches directory files in deterministic order with Unicode columns", async () => {
  const workspace = new MemoryWorkspace({
    "/outside.txt": "Needle outside",
    "/src/a.ts": "🙂Needle\r\nneedle\nx\u2028αNeedle\u2029βNeedle",
    "/src/A.ts": "Needle twice Needle\nno match",
  });
  await workspace.write("/src/z.ts", "no match");

  assert.deepEqual(
    await searchWorkspaceText(workspace, {
      path: "/src",
      query: "Needle",
    }),
    {
      workspace_revision: 1,
      path: "/src",
      query: "Needle",
      matches: [
        {
          path: "/src/A.ts",
          line_number: 1,
          column_number: 1,
          preview: "Needle twice Needle",
        },
        {
          path: "/src/a.ts",
          line_number: 1,
          column_number: 2,
          preview: "🙂Needle",
        },
        {
          path: "/src/a.ts",
          line_number: 4,
          column_number: 2,
          preview: "αNeedle",
        },
        {
          path: "/src/a.ts",
          line_number: 5,
          column_number: 2,
          preview: "βNeedle",
        },
      ],
      files_scanned: 3,
      truncated: false,
    },
  );
});

test("searches one normalized file path and returns one match per line", async () => {
  const workspace = new MemoryWorkspace({
    "/notes/today.md": "a.b a.b\naxb\na.b",
    "/notes/tomorrow.md": "a.b",
  });

  const result = await searchWorkspaceText(workspace, {
    path: "notes/./today.md",
    query: "a.b",
  });

  assert.deepEqual(result, {
    workspace_revision: 0,
    path: "/notes/today.md",
    query: "a.b",
    matches: [
      {
        path: "/notes/today.md",
        line_number: 1,
        column_number: 1,
        preview: "a.b a.b",
      },
      {
        path: "/notes/today.md",
        line_number: 3,
        column_number: 1,
        preview: "a.b",
      },
    ],
    files_scanned: 1,
    truncated: false,
  });
});

test("bounds previews by code point while preserving the complete match", async () => {
  const longQuery = "🙂".repeat(300);
  const maximumQuery = "q".repeat(4_096);
  const workspace = new MemoryWorkspace({
    "/long.txt": `prefix-${longQuery}-suffix`,
    "/maximum.txt": maximumQuery,
    "/short.txt": "0123456789NEEDLEabcdefghij",
  });

  const longResult = await searchWorkspaceText(workspace, {
    path: "/long.txt",
    query: longQuery,
  });
  assert.equal(longResult.matches[0]?.preview, longQuery);
  assert.equal(
    Array.from(longResult.matches[0]?.preview ?? "").length,
    300,
  );
  assert.equal(longResult.matches[0]?.column_number, 8);

  const maximumResult = await searchWorkspaceText(workspace, {
    path: "/maximum.txt",
    query: maximumQuery,
    max_preview_code_points: 1,
  });
  assert.equal(maximumResult.matches[0]?.preview, maximumQuery);

  const boundedResult = await searchWorkspaceText(workspace, {
    path: "/short.txt",
    query: "NEEDLE",
    max_preview_code_points: 12,
  });
  assert.equal(boundedResult.matches[0]?.preview, "789NEEDLEabc");
  assert.equal(
    Array.from(boundedResult.matches[0]?.preview ?? "").length,
    12,
  );
});

test("marks truncation only after observing an additional matching line", async () => {
  const exactWorkspace = new MemoryWorkspace({
    "/one.txt": "find find",
  });
  assert.deepEqual(
    await searchWorkspaceText(exactWorkspace, {
      path: "/",
      query: "find",
      max_matches: 1,
    }),
    {
      workspace_revision: 0,
      path: "/",
      query: "find",
      matches: [{
        path: "/one.txt",
        line_number: 1,
        column_number: 1,
        preview: "find find",
      }],
      files_scanned: 1,
      truncated: false,
    },
  );

  const truncatedWorkspace = new MemoryWorkspace({
    "/a.txt": "find",
    "/b.txt": "none\nfind",
    "/c.txt": "find",
  });
  assert.deepEqual(
    await searchWorkspaceText(truncatedWorkspace, {
      path: "/",
      query: "find",
      max_matches: 1,
    }),
    {
      workspace_revision: 0,
      path: "/",
      query: "find",
      matches: [{
        path: "/a.txt",
        line_number: 1,
        column_number: 1,
        preview: "find",
      }],
      files_scanned: 2,
      truncated: true,
    },
  );
});

test("allows an empty root search and rejects a nonexistent non-root path", async () => {
  const workspace = new MemoryWorkspace();

  assert.deepEqual(
    await searchWorkspaceText(workspace, {
      path: "/",
      query: "anything",
    }),
    {
      workspace_revision: 0,
      path: "/",
      query: "anything",
      matches: [],
      files_scanned: 0,
      truncated: false,
    },
  );
  await assert.rejects(
    searchWorkspaceText(workspace, {
      path: "/missing",
      query: "anything",
    }),
    (error) => error instanceof VfsError && error.code === "not_found",
  );
});

test("rejects malformed search inputs and unsafe helper limits", async () => {
  const workspace = new MemoryWorkspace();
  const invalidInputs = [
    null,
    {},
    { path: "", query: "x" },
    { path: "/", query: "" },
    { path: "/", query: "two\nlines" },
    { path: "/", query: "two\rlines" },
    { path: "/", query: "two\u2028lines" },
    { path: "/", query: "two\u2029lines" },
    { path: "/", query: "\ud800" },
    { path: "/", query: "q".repeat(4_097) },
    { path: "/", query: "x", unknown: true },
    { path: "/", query: "x", max_matches: 0 },
    { path: "/", query: "x", max_matches: 1_001 },
    { path: "/", query: "x", max_matches: 1.5 },
    { path: "/", query: "x", max_preview_code_points: 0 },
    { path: "/", query: "x", max_preview_code_points: 4_097 },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      searchWorkspaceText(workspace, input),
      (error) => error instanceof TypeError || error instanceof RangeError,
    );
  }
  await assert.rejects(
    searchWorkspaceText(workspace, {
      path: "../../outside",
      query: "x",
    }),
    (error) => error instanceof VfsError && error.code === "invalid_path",
  );
});

test("uses conservative portable snapshot limits", async () => {
  const oversizedWorkspace = {
    async list() {
      throw new Error("Bulk capture must not fall back to list.");
    },
    async read() {
      throw new Error("Bulk capture must not fall back to read.");
    },
    async readFilesSnapshot() {
      return {
        workspace_revision: 7,
        files: [{
          path: "/oversized.txt",
          content: "x".repeat(2 * 1024 * 1024 + 1),
        }],
      };
    },
  };

  await assert.rejects(
    searchWorkspaceText(oversizedWorkspace, {
      path: "/oversized.txt",
      query: "x",
    }),
    (error) => error?.code === "limit_exceeded",
  );
});

test("honors real abort signals before capture and while scanning", async () => {
  const workspace = new MemoryWorkspace({
    "/file.txt": "needle",
  });
  const beforeController = new AbortController();
  const beforeReason = new DOMException("Stop now.", "AbortError");
  beforeController.abort(beforeReason);
  await assert.rejects(
    searchWorkspaceText(
      workspace,
      { path: "/", query: "needle" },
      beforeController.signal,
    ),
    (error) => error === beforeReason,
  );

  let markSnapshotRead;
  const snapshotRead = new Promise((resolve) => {
    markSnapshotRead = resolve;
  });
  const duringController = new AbortController();
  const duringReason = new DOMException("Stop scanning.", "AbortError");
  const bulkWorkspace = {
    async list() {
      throw new Error("Bulk capture must not fall back to list.");
    },
    async read() {
      throw new Error("Bulk capture must not fall back to read.");
    },
    async readFilesSnapshot() {
      markSnapshotRead();
      return {
        workspace_revision: 9,
        files: [{
          path: "/file.txt",
          content: "x".repeat(2 * 1024 * 1024),
        }],
      };
    },
  };

  const search = searchWorkspaceText(
    bulkWorkspace,
    { path: "/", query: "missing" },
    duringController.signal,
  );
  await snapshotRead;
  setTimeout(() => duringController.abort(duringReason), 0);
  await assert.rejects(
    search,
    (error) => error === duringReason,
  );
});
