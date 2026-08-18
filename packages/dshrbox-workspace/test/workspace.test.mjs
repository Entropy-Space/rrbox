import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { MemoryWorkspace } from "@researchbox/vfs";
import DshrboxWorkspace from "../src/index.ts";

async function createToolContext(workspace) {
  const context = new Context();
  await context.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
  });
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(DshrboxWorkspace, { workspace });
  return context;
}

async function executeTool(context, name, argumentsValue) {
  return context.tools.execute({
    callId: CallId(`test-${name}`),
    name,
    arguments: argumentsValue,
    signal: new AbortController().signal,
  });
}

test("registers read-only workspace tools with canonical values", async () => {
  const workspace = new MemoryWorkspace({
    "/notes/one.md": "First needle",
    "/notes/two.md": "Second needle",
  });
  const context = await createToolContext(workspace);
  try {
    const list = await executeTool(context, "list_files", {
      path: "/notes",
    });
    assert.equal(list.isError, false);
    assert.deepEqual(list.value, {
      workspace_revision: 0,
      entries: [
        {
          name: "one.md",
          path: "/notes/one.md",
          kind: "file",
          size: 12,
        },
        {
          name: "two.md",
          path: "/notes/two.md",
          kind: "file",
          size: 13,
        },
      ],
    });
    assert.deepEqual(list.content, [{
      type: "text",
      text: JSON.stringify(list.value.entries),
    }]);

    const read = await executeTool(context, "read_file", {
      path: "/notes/one.md",
    });
    assert.equal(read.isError, false);
    assert.deepEqual(read.value, {
      workspace_revision: 0,
      path_revision: 0,
      content: "First needle",
    });
    assert.deepEqual(read.content, [{
      type: "text",
      text: "First needle",
    }]);

    const search = await executeTool(context, "search_files", {
      path: "/notes",
      query: "needle",
    });
    assert.equal(search.isError, false);
    assert.deepEqual(search.value, {
      workspace_revision: 0,
      path: "/notes",
      query: "needle",
      matches: [
        {
          path: "/notes/one.md",
          line_number: 1,
          column_number: 7,
          preview: "First needle",
        },
        {
          path: "/notes/two.md",
          line_number: 1,
          column_number: 8,
          preview: "Second needle",
        },
      ],
      files_scanned: 2,
      truncated: false,
    });
    assert.deepEqual(search.content, [{
      type: "text",
      text: JSON.stringify(search.value),
    }]);
  } finally {
    await context.fiber.dispose();
  }
});

test("keeps VFS failures inside the DSH tool result contract", async () => {
  const context = await createToolContext(new MemoryWorkspace());
  try {
    const result = await executeTool(context, "read_file", {
      path: "/missing.txt",
    });
    assert.equal(result.isError, true);
    assert.match(result.error.message, /File not found/u);
    assert.deepEqual(result.content, [{
      type: "text",
      text: "Error: File not found: /missing.txt",
    }]);
  } finally {
    await context.fiber.dispose();
  }
});
