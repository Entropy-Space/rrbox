import {
  createLlmModelsError,
  createLlmModelsResult,
  createLlmProtocolError,
  createLlmStreamEvent,
  createLlmStreamFinished,
  parseLlmWorkerCommand,
  readLlmStreamId,
  type LlmWorkerEvent,
  type ModelDescriptor,
  type ModelTransport,
} from "@researchbox/model-transport";

export interface LlmWorkerHost {
  onmessage: ((message: MessageEvent<unknown>) => void) | null;
  postMessage(event: LlmWorkerEvent): void;
}

type ActiveStream = {
  controller: AbortController;
};

export type LlmWorkerModelCatalog = {
  listModels(
    providerId: string,
    signal: AbortSignal,
  ): Promise<ModelDescriptor[]>;
};

export function attachLlmWorkerHost(
  host: LlmWorkerHost,
  transport: ModelTransport,
  modelCatalog?: LlmWorkerModelCatalog,
): { close(): void } {
  const activeStreams = new Map<string, ActiveStream>();
  const activeModelRequests = new Map<string, AbortController>();

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

  async function listModels(
    requestId: string,
    providerId: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (!modelCatalog) {
        throw new Error("Model discovery is not configured in the LLM worker.");
      }
      const models = await modelCatalog.listModels(
        providerId,
        controller.signal,
      );
      if (activeModelRequests.get(requestId) !== controller) return;
      activeModelRequests.delete(requestId);
      host.postMessage(createLlmModelsResult(requestId, providerId, models));
    } catch (error) {
      if (activeModelRequests.get(requestId) !== controller) return;
      activeModelRequests.delete(requestId);
      host.postMessage(
        createLlmModelsError(
          requestId,
          providerId,
          error instanceof Error ? error.message : "Model discovery failed.",
        ),
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

    if (command.type === "models_abort") {
      const controller = activeModelRequests.get(command.request_id);
      if (!controller) return;
      activeModelRequests.delete(command.request_id);
      controller.abort();
      return;
    }

    if (command.type === "models_request") {
      const existing = activeModelRequests.get(command.request_id);
      existing?.abort();
      const controller = new AbortController();
      activeModelRequests.set(command.request_id, controller);
      void listModels(
        command.request_id,
        command.payload.provider_id,
        controller,
      );
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
      for (const controller of activeModelRequests.values()) {
        controller.abort();
      }
      activeModelRequests.clear();
    },
  };
}
