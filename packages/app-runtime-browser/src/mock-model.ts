import type { ResearchBoxCoreOptions } from "@researchbox/agent-core";
import type { ModelDescriptor } from "@researchbox/model-transport";

export const researchBoxMockModel: ResearchBoxCoreOptions["model"] = {
  id: "researchbox-mock",
  name: "rrbox Mock",
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

export const researchBoxMockModelDescriptor: ModelDescriptor = {
  provider_id: researchBoxMockModel.provider,
  provider_display_name: "rrbox",
  model_id: researchBoxMockModel.id,
  display_name: researchBoxMockModel.name,
  context_window: researchBoxMockModel.contextWindow,
  max_output_tokens: researchBoxMockModel.maxTokens,
  supports_tools: true,
  supports_reasoning: researchBoxMockModel.reasoning,
  supports_reasoning_effort: false,
};

export const researchBoxSystemPrompt =
  "You are rrbox, a careful coding and research agent working inside a browser-native virtual filesystem.";
