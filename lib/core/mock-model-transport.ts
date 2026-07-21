import {
  parseModelStreamEvent,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTransport,
} from "./model-transport";

export class MockModelTransport implements ModelTransport {
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const response = await fetch("/api/mock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Mock model returned ${response.status}.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) yield parseLine(line);
          newlineIndex = buffer.indexOf("\n");
        }

        if (done) break;
      }

      if (buffer.trim()) yield parseLine(buffer.trim());
    } finally {
      reader.releaseLock();
    }
  }
}

function parseLine(line: string): ModelStreamEvent {
  try {
    return parseModelStreamEvent(JSON.parse(line) as unknown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Invalid model event.";
    throw new Error(`Malformed mock stream: ${reason}`);
  }
}
