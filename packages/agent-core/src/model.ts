/**
 * Model configuration consumed by application runtime coordination.
 *
 * Provider-specific adapters may accept a structurally compatible value, but
 * this contract deliberately does not expose their SDK types to the host.
 */
export type RuntimeModel = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
};
