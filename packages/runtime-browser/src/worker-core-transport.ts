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
import {
  createCoreWorkerDisposeRequest,
  isCoreWorkerDisposedAck,
} from "./core-worker-lifecycle.ts";

type CoreWorker = Pick<
  Worker,
  "addEventListener" | "postMessage" | "removeEventListener" | "terminate"
>;

type Subscriber = {
  onEvent: CoreEventListener;
  onFailure: CoreFailureListener;
};

export type WorkerCoreTransportOptions = {
  disposeTimeoutMs?: number;
};

const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;

export class WorkerCoreTransport implements CoreTransport {
  private readonly worker: CoreWorker;
  private readonly disposeTimeoutMs: number;
  private readonly subscribers = new Set<Subscriber>();
  private state: "open" | "closing" | "closed" = "open";
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    worker: CoreWorker,
    options: WorkerCoreTransportOptions = {},
  ) {
    this.worker = worker;
    this.disposeTimeoutMs =
      options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
    this.worker.addEventListener("messageerror", this.handleMessageError);
  }

  send(command: ViewerCommand): void {
    if (this.state !== "open") {
      throw new Error("The core worker transport is closed.");
    }
    this.worker.postMessage(command);
  }

  subscribe(
    onEvent: CoreEventListener,
    onFailure: CoreFailureListener,
  ): () => void {
    if (this.state !== "open") {
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
    if (this.state !== "open") return;
    this.state = "closing";
    this.subscribers.clear();
    this.disposeTimer = setTimeout(
      this.finishClosing,
      this.disposeTimeoutMs,
    );
    try {
      this.worker.postMessage(createCoreWorkerDisposeRequest());
    } catch {
      this.finishClosing();
    }
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    if (isCoreWorkerDisposedAck(message.data)) {
      if (this.state === "closing") {
        this.finishClosing();
      } else if (this.state === "open") {
        this.notifyFailure("invalid_event");
      }
      return;
    }
    if (this.state !== "open") return;

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
    if (this.state === "closing") {
      this.finishClosing();
      return;
    }
    if (this.state === "closed") return;
    this.notifyFailure("transport_error");
  };

  private readonly handleMessageError = (): void => {
    if (this.state === "closing") {
      this.finishClosing();
      return;
    }
    if (this.state === "closed") return;
    this.notifyFailure("invalid_event");
  };

  private readonly finishClosing = (): void => {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.disposeTimer !== null) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.removeEventListener("messageerror", this.handleMessageError);
    this.worker.terminate();
    this.subscribers.clear();
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
