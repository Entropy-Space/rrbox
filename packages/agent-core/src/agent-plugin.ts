import type { AgentTool } from "@earendil-works/pi-agent-core";

export type AgentPluginContext = {
  project_id: string;
  session_id: string;
};

/**
 * Adds an optional tool surface to an agent session.
 *
 * Plugin instances are application-owned services. The core asks them for
 * session-bound tools but does not own their external resources or lifecycle.
 */
export type AgentPlugin = {
  id: string;
  createTools(context: AgentPluginContext): AgentTool[];
};

export function snapshotAgentPlugins(
  plugins: readonly AgentPlugin[] | undefined,
): readonly AgentPlugin[] {
  if (plugins === undefined) return [];

  const ids = new Set<string>();
  const snapshot = [...plugins];
  for (const plugin of snapshot) {
    if (plugin.id.length === 0) {
      throw new Error("Agent plugin id must not be empty.");
    }
    if (ids.has(plugin.id)) {
      throw new Error(`Duplicate agent plugin id: ${plugin.id}`);
    }
    ids.add(plugin.id);
  }
  return snapshot;
}

export function createAgentPluginTools(
  plugins: readonly AgentPlugin[],
  context: AgentPluginContext,
  builtInTools: readonly AgentTool[],
): AgentTool[] {
  const tools = [...builtInTools];
  const toolNames = new Set(tools.map((tool) => tool.name));

  for (const plugin of plugins) {
    const pluginTools = plugin.createTools(context);
    for (const tool of pluginTools) {
      if (toolNames.has(tool.name)) {
        throw new Error(`Duplicate agent tool name: ${tool.name}`);
      }
      toolNames.add(tool.name);
      tools.push(tool);
    }
  }

  return tools;
}
