import {
  ModelStreamEventSequenceValidator,
  parseModelRequest,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTransport,
} from "./model-transport.ts";

export class HttpNdjsonModelTransport implements ModelTransport {
  private readonly endpoint: string;
  private readonly fetchRequest: typeof fetch;

  constructor(endpoint: string, fetchRequest: typeof fetch = fetch) {
    this.endpoint = endpoint;
    this.fetchRequest = fetchRequest.bind(globalThis);
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    request = parseModelRequest(request);
    const response = await this.fetchRequest(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Model endpoint returned ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sequence = new ModelStreamEventSequenceValidator();
    let buffer = "";
    let sourceEnded = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        sourceEnded = done;
        buffer += decoder.decode(value, { stream: !done });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            const event = parseLine(line, sequence);
            yield event;
            if (event.type === "done") return;
          }
          newlineIndex = buffer.indexOf("\n");
        }

        if (done) {
          if (buffer.trim()) {
            const event = parseLine(buffer.trim(), sequence);
            yield event;
            if (event.type === "done") return;
          }
          throw new Error("Model stream ended before a done event.");
        }
      }
    } finally {
      if (!sourceEnded) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
  }
}

function parseLine(
  line: string,
  sequence: ModelStreamEventSequenceValidator,
): ModelStreamEvent {
  try {
    return sequence.accept(JSON.parse(line) as unknown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invalid model event.";
    throw new Error(`Malformed model stream: ${reason}`);
  }
}
