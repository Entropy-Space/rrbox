import type { PythonExecutor } from "./python-executor.ts";
import {
  createPythonExecuteRequest,
  createPythonErrorResponse,
  parsePythonExecuteResponse,
  type PythonExecuteRequest,
  type PythonExecuteResponse,
  type PythonExecutionResult,
} from "./protocol.ts";

export type BrowserPythonExecutorOptions = {
  createWorker(): Worker;
  timeout_ms?: number;
  max_output_bytes?: number;
};

export class BrowserPythonExecutor implements PythonExecutor {
  private readonly createWorker: () => Worker;
  private readonly timeoutMs: number | undefined;
  private readonly maxOutputBytes: number | undefined;
  private worker: Worker | null = null;
  private active:
    | {
        request: PythonExecuteRequest;
        resolve: (result: PythonExecutionResult) => void;
        reject: (error: unknown) => void;
        timeout: ReturnType<typeof setTimeout>;
        detachAbort: () => void;
      }
    | null = null;
  private closed = false;

  constructor(options: BrowserPythonExecutorOptions) {
    this.createWorker = options.createWorker;
    this.timeoutMs = options.timeout_ms;
    this.maxOutputBytes = options.max_output_bytes;
  }

  execute(
    code: string,
    signal?: AbortSignal,
  ): Promise<PythonExecutionResult> {
    if (this.closed) {
      return Promise.reject(new Error("The Python executor is closed."));
    }
    if (this.active) {
      return Promise.reject(
        new Error("A Python execution is already active."),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    let request: PythonExecuteRequest;
    try {
      request = createPythonExecuteRequest(code, {
        ...(this.timeoutMs === undefined
          ? {}
          : { timeout_ms: this.timeoutMs }),
        ...(this.maxOutputBytes === undefined
          ? {}
          : { max_output_bytes: this.maxOutputBytes }),
      });
    } catch (error) {
      return Promise.reject(error);
    }

    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.active?.request !== request) return;
        this.resetWorker(createAbortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        if (this.active?.request !== request) return;
        this.resetWorker(
          new Error(
            `Python execution exceeded ${request.timeout_ms} ms.`,
          ),
        );
      }, request.timeout_ms);
      this.active = {
        request,
        resolve,
        reject,
        timeout,
        detachAbort: () =>
          signal?.removeEventListener("abort", abort),
      };
      try {
        worker.postMessage(request);
      } catch (error) {
        this.resetWorker(error);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resetWorker(new Error("The Python executor was closed."));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleWorkerError);
    worker.addEventListener("messageerror", this.handleMessageError);
    this.worker = worker;
    return worker;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    const active = this.active;
    if (!active) return;
    let response: PythonExecuteResponse;
    try {
      response = parsePythonExecuteResponse(event.data);
      if (
        response.request_id !== active.request.request_id ||
        (response.result.status === "complete" &&
          response.result.operation_id !==
            active.request.operation_id)
      ) {
        throw new Error(
          "Python Worker returned a response for another execution.",
        );
      }
    } catch (error) {
      this.resetWorker(error);
      return;
    }

    this.active = null;
    clearTimeout(active.timeout);
    active.detachAbort();
    if (response.result.status === "complete") {
      active.resolve(response.result.execution);
    } else {
      active.reject(new Error(response.result.message));
    }
  };

  private readonly handleWorkerError = (event: ErrorEvent) => {
    this.resetWorker(
      new Error(event.message || "The Python Worker failed."),
    );
  };

  private readonly handleMessageError = () => {
    this.resetWorker(
      new Error("The Python Worker returned an unreadable message."),
    );
  };

  private resetWorker(error: unknown): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.removeEventListener("message", this.handleMessage);
      worker.removeEventListener("error", this.handleWorkerError);
      worker.removeEventListener(
        "messageerror",
        this.handleMessageError,
      );
      worker.terminate();
    }
    const active = this.active;
    this.active = null;
    if (active) {
      clearTimeout(active.timeout);
      active.detachAbort();
      active.reject(error);
    }
  }
}

export function createPythonWorkerFailure(
  request: PythonExecuteRequest,
  error: unknown,
): PythonExecuteResponse {
  return createPythonErrorResponse(
    request,
    "internal",
    error instanceof Error
      ? error.message
      : "Python execution failed.",
  ) as PythonExecuteResponse;
}

function createAbortError(): Error {
  return new DOMException("Python execution was aborted.", "AbortError");
}
