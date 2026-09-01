import assert from "node:assert/strict";
import test from "node:test";
import {
  createPythonAgentPlugin,
} from "../src/python-agent-plugin.ts";
import { formatPythonExecution } from "@researchbox/python-plugin/executor";

test("exposes a stateless run_python tool only when composed", async () => {
  const calls = [];
  const plugin = createPythonAgentPlugin({
    async execute(code) {
      calls.push(code);
      return {
        stdout: "42\n",
        stderr: "",
        error: null,
        output_truncated: false,
      };
    },
    close() {},
  });
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
  });

  assert.equal(plugin.id, "python");
  assert.equal(tool.name, "run_python");
  const result = await tool.execute(
    "call",
    { code: "print(6 * 7)" },
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(calls, ["print(6 * 7)"]);
  assert.equal(result.content[0].text, "stdout:\n42\n");
});

test("formats Python exceptions as tool failures", async () => {
  const plugin = createPythonAgentPlugin({
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
  const [tool] = plugin.createTools({
    project_id: "project",
    session_id: "session",
  });

  await assert.rejects(
    tool.execute(
      "call",
      { code: "raise ValueError('bad')" },
      new AbortController().signal,
      () => {},
    ),
    /stdout:\nbefore\n\nerror:\nValueError: bad/u,
  );
  assert.equal(
    formatPythonExecution({
      stdout: "",
      stderr: "",
      error: null,
      output_truncated: false,
    }),
    "Python completed without output.",
  );
});
