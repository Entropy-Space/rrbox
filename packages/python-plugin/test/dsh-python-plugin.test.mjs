import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import {
  DshrboxPython,
} from "../src/dsh-python-plugin.ts";
import { MAX_PYTHON_CODE_BYTES } from "../src/protocol.ts";

async function createToolContext(executor) {
  const context = new Context();
  await context.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
  });
  await context.plugin(ToolRuntime, { mode: "native" });
  await context.plugin(DshrboxPython, { executor });
  return context;
}

async function executePython(context, code, signal = new AbortController().signal) {
  return context.tools.execute({
    callId: CallId("test-run-python"),
    name: "run_python",
    arguments: { code },
    signal,
  });
}

test("registers run_python as a native DSH tool", async () => {
  const calls = [];
  let closed = false;
  const context = await createToolContext({
    async execute(code, signal) {
      calls.push({ code, signal });
      return {
        stdout: "42\n",
        stderr: "warning\n",
        error: null,
        output_truncated: true,
      };
    },
    close() {
      closed = true;
    },
  });
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(
      context.tools.schemas().map((tool) => tool.name),
      ["run_python"],
    );
    const result = await executePython(context, "print(6 * 7)", signal);
    assert.equal(result.isError, false);
    assert.deepEqual(calls, [{ code: "print(6 * 7)", signal }]);
    assert.deepEqual(result.value, {
      stdout: "42\n",
      stderr: "warning\n",
      output_truncated: true,
    });
    assert.deepEqual(result.content, [{
      type: "text",
      text: "stdout:\n42\n\nstderr:\nwarning\n\n[output truncated]",
    }]);
    assert.deepEqual(result.meta, {
      summary: "Python completed (output truncated)",
    });
  } finally {
    await context.fiber.dispose();
  }
  assert.equal(closed, false, "the application retains executor ownership");
});

test("turns Python failures and oversized input into DSH tool failures", async () => {
  const context = await createToolContext({
    async execute() {
      return {
        stdout: "before\n",
        stderr: "",
        error: "ValueError: bad\n",
        output_truncated: false,
      };
    },
    close() {},
  });
  try {
    const failed = await executePython(context, "raise ValueError('bad')");
    assert.equal(failed.isError, true);
    assert.match(
      failed.error.message,
      /stdout:\nbefore\n\nerror:\nValueError: bad/u,
    );

    const oversized = await executePython(
      context,
      "x".repeat(MAX_PYTHON_CODE_BYTES + 1),
    );
    assert.equal(oversized.isError, true);
    assert.match(oversized.error.message, /exceeds 262144 UTF-8 bytes/u);
  } finally {
    await context.fiber.dispose();
  }
});
