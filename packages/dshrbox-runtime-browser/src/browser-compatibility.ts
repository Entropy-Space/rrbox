export const DSH_BROWSER_COMPATIBILITY = Object.freeze({
  async_context: "single_foreground_chain",
  max_live_agents: 1,
  max_parallel_tool_calls: 1,
} as const);

export type DshBrowserCompatibility = typeof DSH_BROWSER_COMPATIBILITY;
