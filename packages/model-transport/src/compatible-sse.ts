import { EventSourceParserStream } from "eventsource-parser/stream";
export class CompatibleStreamTruncatedError extends Error {
  constructor() { super("OpenAI-compatible stream ended before [DONE]."); }
}

/** Preserve the compatible protocol's [DONE] boundary before AI SDK parsing.
 * Some existing endpoints omit finish_reason; only an explicit [DONE] may
 * supply that default. EOF never promotes a truncated stream to success.
 */
export function frameCompatibleResponse(response: Response): Response {
  if (!response.body) throw new Error("Chat completions endpoint returned an empty body.");
  let terminated = false;
  let hasFinishReason = false;
  let hasTools = false;
  const encoder = new TextEncoder();
  const body = response.body.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: 16 * 1024 * 1024 }))
    .pipeThrough(new TransformStream({
      transform(event, controller) {
        if (event.data.trim() === "[DONE]") {
          terminated = true;
          if (!hasFinishReason) controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: hasTools ? "tool_calls" : "stop" }],
          })}\n\n`));
          controller.terminate();
          return;
        }
        // This look-ahead only supplies a missing terminator reason; AI SDK
        // remains responsible for parsing and validating the actual chunks.
        try {
          const value = JSON.parse(event.data) as { choices?: { finish_reason?: unknown; delta?: { tool_calls?: unknown } }[] };
          const choice = value.choices?.[0];
          if (choice?.finish_reason != null) hasFinishReason = true;
          if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0) hasTools = true;
        } catch { /* Let AI SDK report malformed JSON. */ }
        controller.enqueue(encoder.encode(`${event.data.split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`));
      },
      flush() {
        if (!terminated) throw new CompatibleStreamTruncatedError();
      },
    }));
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
