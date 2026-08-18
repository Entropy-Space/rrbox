# `@dshrbox/model-adapter`

Adapts DSH's provider-neutral LLM contract to rrbox's existing
`ModelTransport` boundary. This keeps provider credentials, worker isolation,
and HTTP transport ownership outside DSH while allowing the DSH agent loop to
drive model calls.

The adapter currently supports:

- text, reasoning, tool calls, and tool results;
- provider-scoped model discovery when a catalog is supplied;
- DSH cancellation through the transport's `AbortSignal`;
- validation of both the DSH transcript and the transport event sequence.

The existing transport is text-only and has no fields for `temperature`,
`maxTokens`, or `stop`. The adapter rejects those options instead of silently
changing their meaning. It also rejects image content until the transport owns
an explicit image representation. `ModelTransport` does not expose token usage,
so the adapter does not synthesize a DSH usage chunk.

```ts
import { ModelTransportLlmAdapter } from "@dshrbox/model-adapter";

const adapter = new ModelTransportLlmAdapter(
  workerModelTransport,
  workerModelTransport,
);
```
