import {
  createLlmProtocolError,
  createLlmStreamEvent,
  createLlmStreamFinished,
  parseLlmWorkerCommand,
  readLlmStreamId,
  type LlmWorkerEvent,
  type ModelTransport,
} from "@researchbox/model-transport";

export interface LlmWorkerHost {
  onmessage: ((message: MessageEvent<unknown>) => void) | null;
  postMessage(event: LlmWorkerEvent): void;
}

type ActiveStream = {
  controller: AbortController;
};

export function attachLlmWorkerHost(
  host: LlmWorkerHost,
  transport: ModelTransport,
): { close(): void } {
  const activeStreams = new Map<string, ActiveStream>();

  function finish(
    streamId: string,
    stream: ActiveStream,
    status: "complete" | "aborted" | "error",
    errorMessage?: string,
  ): void {
    if (activeStreams.get(streamId) !== stream) return;
    activeStreams.delete(streamId);
    host.postMessage(
      status === "error"
        ? createLlmStreamFinished(
            streamId,
            "error",
            errorMessage ?? "The LLM stream failed.",
          )
        : createLlmStreamFinished(streamId, status),
    );
  }

  async function pump(
    streamId: string,
    stream: ActiveStream,
    request: Parameters<ModelTransport["stream"]>[0],
  ): Promise<void> {
    let sawDone = false;
    try {
      for await (const event of transport.stream(request, stream.controller.signal)) {
        if (activeStreams.get(streamId) !== stream) return;
        if (stream.controller.signal.aborted) {
          finish(streamId, stream, "aborted");
          return;
        }
        host.postMessage(createLlmStreamEvent(streamId, event));
        if (event.type === "done") {
          sawDone = true;
          break;
        }
      }

      if (!sawDone) {
        throw new Error("Model transport ended before a done event.");
      }
      finish(streamId, stream, "complete");
    } catch (error) {
      if (stream.controller.signal.aborted) {
        finish(streamId, stream, "aborted");
        return;
      }
      finish(
        streamId,
        stream,
        "error",
        error instanceof Error ? error.message : "The model transport failed.",
      );
    }
  }

  host.onmessage = (message) => {
    let command;
    try {
      command = parseLlmWorkerCommand(message.data);
    } catch (error) {
      const streamId = readLlmStreamId(message.data);
      const errorMessage =
        error instanceof Error ? error.message : "Invalid LLM worker command.";
      if (streamId) {
        const stream = activeStreams.get(streamId);
        if (stream) {
          stream.controller.abort();
          finish(streamId, stream, "error", errorMessage);
        } else {
          host.postMessage(
            createLlmStreamFinished(streamId, "error", errorMessage),
          );
        }
      } else {
        host.postMessage(createLlmProtocolError(errorMessage));
      }
      return;
    }

    if (command.type === "stream_abort") {
      const stream = activeStreams.get(command.stream_id);
      if (!stream) return;
      stream.controller.abort();
      finish(command.stream_id, stream, "aborted");
      return;
    }

    if (activeStreams.has(command.stream_id)) {
      const stream = activeStreams.get(command.stream_id);
      if (stream) {
        stream.controller.abort();
        finish(
          command.stream_id,
          stream,
          "error",
          "An LLM stream with this stream_id is already active.",
        );
      }
      return;
    }

    const stream: ActiveStream = { controller: new AbortController() };
    activeStreams.set(command.stream_id, stream);
    void pump(command.stream_id, stream, command.payload.model_request);
  };

  return {
    close() {
      host.onmessage = null;
      for (const [streamId, stream] of activeStreams) {
        stream.controller.abort();
        finish(streamId, stream, "aborted");
      }
    },
  };
}
