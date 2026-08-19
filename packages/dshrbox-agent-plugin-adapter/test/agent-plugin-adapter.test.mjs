import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { Type } from "@earendil-works/pi-ai";
import DshrboxAgentPluginAdapter, {
  createDshrboxAgentToolDefinitions,
} from "../src/index.ts";

async function createToolContext(plugin) {
  const context = new Context();
  await context.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
  });
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(DshrboxAgentPluginAdapter, {
    plugins: [plugin],
    context: {
      project_id: "adapter-project",
      session_id: "adapter-session",
    },
  });
  return context;
}

function executeTool(context, name, args, signal = new AbortController().signal) {
  return context.tools.execute({
    callId: CallId(`test-${name}`),
    name,
    arguments: args,
    signal,
  });
}

test("projects legacy schemas and preserves text and details", async () => {
  let observedCall = null;
  const plugin = {
    id: "legacy-search",
    createTools(pluginContext) {
      assert.equal(pluginContext.project_id, "adapter-project");
      const parameters = Type.Object({
        query: Type.String({ minLength: 2, maxLength: 20 }),
        mode: Type.Optional(Type.Union([
          Type.Literal("quick"),
          Type.Literal("deep"),
        ])),
      });
      return [{
        name: "legacy_search",
        label: "Legacy search",
        description: "Search through a legacy tool.",
        parameters,
        executionMode: "parallel",
        prepareArguments(args) {
          return { ...args, query: args.query.trim() };
        },
        async execute(toolCallId, args, signal) {
          observedCall = { toolCallId, args, signal };
          return {
            content: [{ type: "text", text: `Found ${args.query}` }],
            details: { summary: "Legacy search completed", count: 1 },
          };
        },
      }];
    },
  };
  const context = await createToolContext(plugin);
  try {
    const definition = context.tools.get("legacy_search");
    assert.ok(definition);
    assert.deepEqual(definition.parameters, {
      type: "object",
      properties: {
        query: { type: "string" },
        mode: {
          oneOf: [
            { type: "string", const: "quick" },
            { type: "string", const: "deep" },
          ],
        },
      },
      required: ["query"],
    });
    assert.equal(definition.isConcurrencySafe?.({}), true);

    const signal = new AbortController().signal;
    const result = await executeTool(context, "legacy_search", {
      query: "  docs  ",
      mode: "deep",
    }, signal);
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{
      type: "text",
      text: "Found docs",
    }]);
    assert.deepEqual(result.meta, {
      summary: "Legacy search completed",
      count: 1,
    });
    assert.deepEqual(result.value, {
      content: [{ type: "text", text: "Found docs" }],
      details: {
        summary: "Legacy search completed",
        count: 1,
      },
    });
    assert.equal(observedCall.toolCallId, "test-legacy_search");
    assert.deepEqual(observedCall.args, { query: "docs", mode: "deep" });
    assert.equal(observedCall.signal, signal);
  } finally {
    await context.fiber.dispose();
  }
});

test("keeps stripped TypeBox constraints authoritative at execution", async () => {
  const plugin = {
    id: "bounded",
    createTools() {
      const parameters = Type.Object({
        query: Type.String({ minLength: 2 }),
      });
      return [{
        name: "bounded_tool",
        label: "Bounded tool",
        description: "Reject short queries.",
        parameters,
        async execute() {
          return { content: [], details: undefined };
        },
      }];
    },
  };
  const context = await createToolContext(plugin);
  try {
    const result = await executeTool(context, "bounded_tool", { query: "x" });
    assert.equal(result.isError, true);
    assert.match(result.error.message, /Invalid arguments for legacy tool/u);
    assert.match(result.error.message, /fewer than 2 characters/u);
  } finally {
    await context.fiber.dispose();
  }
});

test("rejects result semantics that cannot round-trip through DSH", async () => {
  for (const testCase of [
    {
      name: "image_tool",
      result: {
        content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        details: {},
      },
      message: /unsupported inline image content/u,
    },
    {
      name: "terminating_tool",
      result: {
        content: [{ type: "text", text: "done" }],
        details: {},
        terminate: true,
      },
      message: /unsupported terminate=true/u,
    },
    {
      name: "non_json_details_tool",
      result: {
        content: [{ type: "text", text: "done" }],
        details: { invalid: undefined },
      },
      message: /details that are not lossless JSON/u,
    },
  ]) {
    const plugin = {
      id: testCase.name,
      createTools() {
        return [{
          name: testCase.name,
          label: testCase.name,
          description: "Return an unsupported legacy result.",
          parameters: Type.Object({}),
          async execute() {
            return testCase.result;
          },
        }];
      },
    };
    const context = await createToolContext(plugin);
    try {
      const result = await executeTool(context, testCase.name, {});
      assert.equal(result.isError, true);
      assert.match(result.error.message, testCase.message);
    } finally {
      await context.fiber.dispose();
    }
  }
});

test("refuses overlapping TypeBox unions instead of changing their meaning", () => {
  const plugin = {
    id: "overlapping-union",
    createTools() {
      return [{
        name: "overlapping_union",
        label: "Overlapping union",
        description: "Uses an anyOf that cannot become oneOf.",
        parameters: Type.Object({
          value: Type.Union([Type.String(), Type.Literal("specific")]),
        }),
        async execute() {
          return { content: [], details: null };
        },
      }];
    },
  };
  assert.throws(
    () => createDshrboxAgentToolDefinitions([plugin], {
      project_id: "adapter-project",
      session_id: "adapter-session",
    }),
    /cannot be safely projected to DSH oneOf/u,
  );
});
