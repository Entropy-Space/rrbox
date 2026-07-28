import type { PythonExecutor } from "./python-plugin.ts";
import {
  createPythonCancelRequest,
  createPythonExecuteRequest,
  parsePythonResponse,
  type PythonExecutionResult,
  type PythonRequest,
  type PythonResponse,
} from "./protocol.ts";

type PendingRequest = {
  request: PythonRequest;
  resolve: (response: PythonResponse) => void;
  reject: (error: unknown) => void;
};

export class NativePythonRpcClient implements PythonExecutor {
  private readonly port: MessagePort;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number | undefined;
  private readonly maxOutputBytes: number | undefined;
  private activeOperationId: string | null = null;
  private closed = false;

  constructor(
    port: MessagePort,
    options: {
      timeout_ms?: number;
      max_output_bytes?: number;
    } = {},
  ) {
    this.port = port;
    this.timeoutMs = options.timeout_ms;
    this.maxOutputBytes = options.max_output_bytes;
    port.addEventListener("message", this.handleMessage);
    port.addEventListener("messageerror", this.handleMessageError);
    port.start();
  }

  async execute(
    code: string,
    signal?: AbortSignal,
  ): Promise<PythonExecutionResult> {
    if (this.activeOperationId !== null) {
      throw new Error("A Python execution is already active.");
    }
    if (signal?.aborted) throw createAbortError();
    const request = createPythonExecuteRequest(code, {
      ...(this.timeoutMs === undefined
        ? {}
        : { timeout_ms: this.timeoutMs }),
      ...(this.maxOutputBytes === undefined
        ? {}
        : { max_output_bytes: this.maxOutputBytes }),
    });
    this.activeOperationId = request.operation_id;

    const abort = () => {
      void this.cancel(request.operation_id);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.send(request);
      if (signal?.aborted) throw createAbortError();
      if (response.kind !== "python_execute_result") {
        throw new Error("Native Python returned the wrong response kind.");
      }
      if (response.result.status === "error") {
        if (response.result.code === "cancelled") {
          throw createAbortError();
        }
        throw new Error(response.result.message);
      }
      if (response.result.operation_id !== request.operation_id) {
        throw new Error(
          "Native Python returned another operation's result.",
        );
      }
      return response.result.execution;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.activeOperationId === request.operation_id) {
        this.activeOperationId = null;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    const operationId = this.activeOperationId;
    this.activeOperationId = null;
    if (operationId !== null) void this.cancel(operationId);
    this.closed = true;
    this.port.removeEventListener("message", this.handleMessage);
    this.port.removeEventListener(
      "messageerror",
      this.handleMessageError,
    );
    this.port.close();
    const error = new Error("The native Python channel was closed.");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async cancel(operationId: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.send(createPythonCancelRequest(operationId));
    } catch {
      // Cancellation is best-effort while the owning core is shutting down.
    }
  }

  private send(request: PythonRequest): Promise<PythonResponse> {
    if (this.closed) {
      return Promise.reject(
        new Error("The native Python channel is closed."),
      );
    }
    if (this.pending.has(request.request_id)) {
      return Promise.reject(
        new Error(`Duplicate Python request id: ${request.request_id}`),
      );
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.request_id, {
        request,
        resolve,
        reject,
      });
      try {
        this.port.postMessage(request);
      } catch (error) {
        this.pending.delete(request.request_id);
        reject(error);
      }
    });
  }

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    let response: PythonResponse;
    try {
      response = parsePythonResponse(event.data);
    } catch (error) {
      this.fail(error);
      return;
    }
    const pending = this.pending.get(response.request_id);
    if (!pending) return;
    this.pending.delete(response.request_id);
    pending.resolve(response);
  };

  private readonly handleMessageError = () => {
    this.fail(
      new Error("The native Python channel emitted an unreadable message."),
    );
  };

  private fail(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function createAbortError(): Error {
  return new DOMException("Python execution was aborted.", "AbortError");
}
