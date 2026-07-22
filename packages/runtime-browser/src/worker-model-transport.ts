import {
  createLlmModelsAbort,
  createLlmModelsRequest,
  createLlmStreamAbort,
  createLlmStreamStart,
  parseLlmWorkerEvent,
  readLlmRequestId,
  readLlmStreamId,
  type LlmWorkerCommand,
  type ModelDescriptor,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTransport,
} from "@researchbox/model-transport";

type ModelWorker = Pick<
  Worker,
  "addEventListener" | "postMessage" | "removeEventListener" | "terminate"
>;

type PendingStream = {
  events: ModelStreamEvent[];
  failure: Error | null;
  is_finished: boolean;
  remote_finished: boolean;
  saw_done: boolean;
  abort_sent: boolean;
  wake: (() => void) | null;
};

type PendingModels = {
  provider_id: string;
  resolve: (models: ModelDescriptor[]) => void;
  reject: (error: Error) => void;
  remove_abort_listener: () => void;
};

type FatalErrorListener = (error: Error) => void;

export class WorkerModelTransport implements ModelTransport {
  private readonly worker: ModelWorker;
  private readonly streams = new Map<string, PendingStream>();
  private readonly modelRequests = new Map<string, PendingModels>();
  private readonly fatalErrorListeners = new Set<FatalErrorListener>();
  private fatalError: Error | null = null;
  private isClosed = false;

  constructor(worker: ModelWorker) {
    this.worker = worker;
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
    this.worker.addEventListener("messageerror", this.handleMessageError);
  }

  subscribeFatalError(listener: FatalErrorListener): () => void {
    this.fatalErrorListeners.add(listener);
    if (this.fatalError) notifyFatalErrorListener(listener, this.fatalError);
    return () => this.fatalErrorListeners.delete(listener);
  }

  listModels(
    providerId: string,
    signal: AbortSignal,
  ): Promise<ModelDescriptor[]> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.isClosed) {
      return Promise.reject(new Error("The LLM worker transport is closed."));
    }
    if (signal.aborted) return Promise.reject(createAbortError());

    const requestId = crypto.randomUUID();
    return new Promise<ModelDescriptor[]>((resolve, reject) => {
      const abort = () => {
        const pending = this.modelRequests.get(requestId);
        if (!pending) return;
        this.sendModelsAbort(requestId);
        this.modelRequests.delete(requestId);
        pending.remove_abort_listener();
        reject(createAbortError());
      };
      signal.addEventListener("abort", abort, { once: true });
      const pending: PendingModels = {
        provider_id: providerId,
        resolve,
        reject,
        remove_abort_listener: () => signal.removeEventListener("abort", abort),
      };
      this.modelRequests.set(requestId, pending);
      try {
        this.postCommand(createLlmModelsRequest(requestId, providerId));
      } catch (error) {
        this.modelRequests.delete(requestId);
        pending.remove_abort_listener();
        reject(
          error instanceof Error
            ? error
            : new Error("Could not request models from the LLM worker."),
        );
      }
    });
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    if (this.fatalError) throw this.fatalError;
    if (this.isClosed) throw new Error("The LLM worker transport is closed.");
    if (signal.aborted) throw createAbortError();

    const streamId = crypto.randomUUID();
    const pending: PendingStream = {
      events: [],
      failure: null,
      is_finished: false,
      remote_finished: false,
      saw_done: false,
      abort_sent: false,
      wake: null,
    };
    this.streams.set(streamId, pending);

    const abort = () => {
      this.sendAbort(streamId, pending);
      failPending(pending, createAbortError(), false);
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      this.postCommand(createLlmStreamStart(streamId, request));

      while (true) {
        if (pending.failure) throw pending.failure;
        const event = pending.events.shift();
        if (event) {
          yield event;
          continue;
        }
        if (pending.is_finished) return;
        await waitForPending(pending);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.streams.get(streamId) === pending) {
        if (!pending.remote_finished) this.sendAbort(streamId, pending);
        this.streams.delete(streamId);
      }
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.removeEventListener("messageerror", this.handleMessageError);
    for (const [streamId, pending] of this.streams) {
      this.sendAbort(streamId, pending);
      failPending(
        pending,
        new Error("The LLM worker transport was closed."),
        false,
      );
    }
    this.streams.clear();
    this.failAllModelRequests(
      new Error("The LLM worker transport was closed."),
    );
    this.fatalErrorListeners.clear();
    this.isClosed = true;
    this.worker.terminate();
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    let event;
    try {
      event = parseLlmWorkerEvent(message.data);
    } catch (error) {
      const streamId = readLlmStreamId(message.data);
      const requestId = readLlmRequestId(message.data);
      const failure = new Error(
        error instanceof Error
          ? `Invalid LLM worker event: ${error.message}`
          : "Invalid LLM worker event.",
      );
      const pending = streamId ? this.streams.get(streamId) : undefined;
      if (pending) {
        failPending(pending, failure, false);
      } else if (requestId && this.modelRequests.has(requestId)) {
        this.rejectModelRequest(requestId, failure);
      } else {
        this.failAll(failure);
      }
      return;
    }

    if (event.type === "protocol_error") {
      this.failAll(new Error(event.payload.message));
      return;
    }

    if (event.type === "models_result" || event.type === "models_error") {
      const pending = this.modelRequests.get(event.request_id);
      if (!pending) return;
      if (event.payload.provider_id !== pending.provider_id) {
        this.rejectModelRequest(
          event.request_id,
          new Error("The LLM worker returned models for the wrong provider."),
        );
        return;
      }
      this.modelRequests.delete(event.request_id);
      pending.remove_abort_listener();
      if (event.type === "models_result") {
        pending.resolve(event.payload.models);
      } else {
        pending.reject(new Error(event.payload.error_message));
      }
      return;
    }

    const pending = this.streams.get(event.stream_id);
    if (!pending || pending.is_finished) return;

    if (event.type === "stream_event") {
      if (pending.saw_done) {
        failPending(
          pending,
          new Error("The LLM worker sent an event after done."),
          false,
        );
        return;
      }
      pending.events.push(event.payload.model_event);
      pending.saw_done = event.payload.model_event.type === "done";
      notifyPending(pending);
      return;
    }

    pending.remote_finished = true;
    if (event.payload.status === "complete") {
      if (!pending.saw_done) {
        failPending(
          pending,
          new Error("The LLM worker finished without a done event."),
          true,
        );
        return;
      }
      pending.is_finished = true;
      notifyPending(pending);
      return;
    }

    failPending(
      pending,
      event.payload.status === "aborted"
        ? createAbortError()
        : new Error(event.payload.error_message ?? "The LLM request failed."),
      true,
    );
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    event.preventDefault();
    this.failFatally(
      new Error(event.message || "The LLM worker stopped unexpectedly."),
    );
  };

  private readonly handleMessageError = (): void => {
    this.failFatally(new Error("The LLM worker returned an unreadable message."));
  };

  private postCommand(command: LlmWorkerCommand): void {
    try {
      this.worker.postMessage(command);
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("Could not send a command to the LLM worker.");
    }
  }

  private sendAbort(streamId: string, pending: PendingStream): void {
    if (pending.abort_sent || pending.remote_finished || this.isClosed) return;
    pending.abort_sent = true;
    try {
      this.postCommand(createLlmStreamAbort(streamId));
    } catch {
      // A worker failure is already surfaced through the active stream.
    }
  }

  private sendModelsAbort(requestId: string): void {
    if (this.isClosed) return;
    try {
      this.postCommand(createLlmModelsAbort(requestId));
    } catch {
      // The local abort is still authoritative for the caller.
    }
  }

  private failFatally(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    this.failAll(error);
    for (const listener of this.fatalErrorListeners) {
      notifyFatalErrorListener(listener, error);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.streams.values()) {
      failPending(pending, error, false);
    }
    this.failAllModelRequests(error);
  }

  private rejectModelRequest(requestId: string, error: Error): void {
    const pending = this.modelRequests.get(requestId);
    if (!pending) return;
    this.modelRequests.delete(requestId);
    pending.remove_abort_listener();
    pending.reject(error);
  }

  private failAllModelRequests(error: Error): void {
    for (const requestId of [...this.modelRequests.keys()]) {
      this.rejectModelRequest(requestId, error);
    }
  }
}

function waitForPending(pending: PendingStream): Promise<void> {
  return new Promise((resolve) => {
    pending.wake = resolve;
  });
}

function notifyPending(pending: PendingStream): void {
  const wake = pending.wake;
  pending.wake = null;
  wake?.();
}

function failPending(
  pending: PendingStream,
  error: Error,
  remoteFinished: boolean,
): void {
  if (pending.is_finished) return;
  pending.failure = error;
  pending.is_finished = true;
  pending.remote_finished = remoteFinished;
  notifyPending(pending);
}

function createAbortError(): Error {
  return new DOMException("The LLM request was aborted.", "AbortError");
}

function notifyFatalErrorListener(
  listener: FatalErrorListener,
  error: Error,
): void {
  try {
    listener(error);
  } catch {
    // Transport health consumers are isolated from request failure handling.
  }
}
