import type {
  CoreEventListener,
  CoreFailureListener,
  CoreTransport,
  CoreTransportFailure,
} from "@researchbox/client";
import {
  parseCoreEvent,
  type ViewerCommand,
} from "@researchbox/protocol";

type CoreWorker = Pick<
  Worker,
  "addEventListener" | "postMessage" | "removeEventListener" | "terminate"
>;

type Subscriber = {
  onEvent: CoreEventListener;
  onFailure: CoreFailureListener;
};

export class WorkerCoreTransport implements CoreTransport {
  private readonly worker: CoreWorker;
  private readonly subscribers = new Set<Subscriber>();
  private isClosed = false;

  constructor(worker: CoreWorker) {
    this.worker = worker;
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
    this.worker.addEventListener("messageerror", this.handleMessageError);
  }

  send(command: ViewerCommand): void {
    if (this.isClosed) {
      throw new Error("The core worker transport is closed.");
    }
    this.worker.postMessage(command);
  }

  subscribe(
    onEvent: CoreEventListener,
    onFailure: CoreFailureListener,
  ): () => void {
    if (this.isClosed) {
      notifyFailureListener(onFailure, "transport_error");
      return () => undefined;
    }

    const subscriber = { onEvent, onFailure };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.removeEventListener("messageerror", this.handleMessageError);
    this.worker.terminate();
    this.subscribers.clear();
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    let event;
    try {
      event = parseCoreEvent(message.data);
    } catch {
      this.notifyFailure("invalid_event");
      return;
    }

    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.onEvent(event);
      } catch {
        // A consumer failure must not prevent other subscribers from updating.
      }
    }
  };

  private readonly handleWorkerError = (): void => {
    this.notifyFailure("transport_error");
  };

  private readonly handleMessageError = (): void => {
    this.notifyFailure("invalid_event");
  };

  private notifyFailure(failure: CoreTransportFailure): void {
    for (const subscriber of [...this.subscribers]) {
      notifyFailureListener(subscriber.onFailure, failure);
    }
  }
}

function notifyFailureListener(
  listener: CoreFailureListener,
  failure: CoreTransportFailure,
): void {
  try {
    listener(failure);
  } catch {
    // Transport health consumers are isolated from one another.
  }
}
