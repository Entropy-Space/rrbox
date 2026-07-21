import { MemoryFileSystem } from "@researchbox/vfs";

export function createResearchBoxFileSystem(): MemoryFileSystem {
  return new MemoryFileSystem({
    "/README.md": [
      "# ResearchBox",
      "",
      "A browser-native workspace for a Pi agent.",
      "",
      "## Architecture",
      "",
      "- The viewer speaks a versioned JSON protocol.",
      "- The agent core runs in a Web Worker.",
      "- Storage is provided through a virtual filesystem interface.",
    ].join("\n"),
    "/notes/product-brief.md": [
      "# Product brief",
      "",
      "Make powerful agent workflows feel as calm as a conversation.",
      "The browser is a first-class runtime, not a fallback.",
    ].join("\n"),
    "/src/agent.ts": [
      'export const system_prompt = "You are a careful research partner.";',
      "",
      "export type AgentRuntime = {",
      "  run(input: string): Promise<void>;",
      "};",
    ].join("\n"),
    "/src/tools.ts": [
      'export const tools = ["read_file", "write_file", "list_files"];',
    ].join("\n"),
  });
}
