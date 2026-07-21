import type { ResearchBoxCoreOptions } from "@researchbox/agent-core";

export const researchBoxMockModel: ResearchBoxCoreOptions["model"] = {
  id: "researchbox-mock",
  name: "ResearchBox Mock",
  api: "researchbox-mock",
  provider: "researchbox",
  baseUrl: "/api/mock",
  reasoning: false,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

export const researchBoxSystemPrompt =
  "You are ResearchBox, a careful coding and research agent working inside a browser-native virtual filesystem.";
