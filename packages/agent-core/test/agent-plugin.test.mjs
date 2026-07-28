import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentPluginTools,
  snapshotAgentPlugins,
} from "../src/agent-plugin.ts";

const context = {
  project_id: "project",
  session_id: "session",
};

test("snapshots opt-in agent plugins and composes their tools", () => {
  const plugins = [{
    id: "python",
    createTools(receivedContext) {
      assert.deepEqual(receivedContext, context);
      return [{ name: "run_python" }];
    },
  }];

  const snapshot = snapshotAgentPlugins(plugins);
  plugins.length = 0;

  assert.deepEqual(
    createAgentPluginTools(snapshot, context, [{ name: "read_file" }])
      .map((tool) => tool.name),
    ["read_file", "run_python"],
  );
});

test("rejects duplicate plugin ids and tool names", () => {
  assert.throws(
    () => snapshotAgentPlugins([
      { id: "python", createTools: () => [] },
      { id: "python", createTools: () => [] },
    ]),
    /Duplicate agent plugin id/,
  );
  assert.throws(
    () => createAgentPluginTools(
      [{
        id: "python",
        createTools: () => [{ name: "read_file" }],
      }],
      context,
      [{ name: "read_file" }],
    ),
    /Duplicate agent tool name/,
  );
});
