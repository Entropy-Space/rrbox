import {
  ProjectStoreConflictError,
} from "@researchbox/project-store";
import {
  VfsError,
  WorkspaceBackendError,
  WorkspaceCorruptionError,
  type VfsErrorCode,
} from "@researchbox/vfs";
import {
  NATIVE_STORAGE_PROTOCOL_VERSION,
  nativeStorageResultKindByOperation,
  parseNativeStorageResponse,
  type NativeStorageError,
  type NativeStorageErrorCode,
  type NativeStorageOperation,
  type NativeStorageRequest,
  type NativeStorageResponse,
  type NativeStorageResultFor,
} from "./protocol.ts";
import {
  validateNativeStorageResultForOperation,
} from "./operation-result-validation.ts";

export type NativeStorageRpcEndpoint = {
  postMessage(message: NativeStorageRequest): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  start?(): void;
  close?(): void;
};

export type NativeStorageRpcClientOptions = {
  create_request_id?: () => string;
};

export type NativeStorageRequestOptions = {
  signal?: AbortSignal;
};

type PendingRequest = {
  operation: NativeStorageOperation;
  resolve(result: unknown): void;
  reject(error: unknown): void;
  remove_abort_listener(): void;
};

export class NativeStorageRpcError extends Error {
  public readonly code: Extract<
    NativeStorageErrorCode,
    "invalid_request" | "internal"
  >;

  constructor(
    code: NativeStorageRpcError["code"],
    message: string,
  ) {
    super(message);
    this.name = "NativeStorageRpcError";
    this.code = code;
  }
}

export class NativeStorageProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeStorageProtocolError";
  }
}

export class NativeStorageRpcClient {
  private readonly endpoint: NativeStorageRpcEndpoint;
  private readonly createRequestId: () => string;
  private readonly pending = new Map<string, PendingRequest>();
  private initialization: Promise<void> | null = null;
  private closed = false;

  constructor(
    endpoint: NativeStorageRpcEndpoint,
    options: NativeStorageRpcClientOptions = {},
  ) {
    this.endpoint = endpoint;
    this.createRequestId =
      options.create_request_id ?? createDefaultRequestId;
    this.endpoint.addEventListener("message", this.handleMessage);
    this.endpoint.addEventListener(
      "messageerror",
      this.handleMessageError,
    );
    this.endpoint.start?.();
  }

  async health(): Promise<boolean> {
    const result = await this.request({ kind: "health" });
    return result.initialized;
  }

  ensureInitialized(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.request({ kind: "initialize" })
      .then(() => undefined)
      .catch((error) => {
        this.initialization = null;
        throw error;
      });
    return this.initialization;
  }

  async getProjectUsage(projectId: string) {
    await this.ensureInitialized();
    const result = await this.request({
      kind: "project_usage",
      project_id: projectId,
    });
    return structuredClone(result.value);
  }

  request<TOperation extends NativeStorageOperation>(
    operation: TOperation,
    options: NativeStorageRequestOptions = {},
  ): Promise<NativeStorageResultFor<TOperation>> {
    if (this.closed) {
      return Promise.reject(
        new NativeStorageProtocolError(
          "The native storage connection is closed.",
        ),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const requestId = this.createUniqueRequestId();
    const request: NativeStorageRequest = {
      protocol_version: NATIVE_STORAGE_PROTOCOL_VERSION,
      request_id: requestId,
      operation: structuredClone(operation),
    };

    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.remove_abort_listener();
        reject(createAbortError());
      };
      const removeAbortListener = () =>
        options.signal?.removeEventListener("abort", abort);
      this.pending.set(requestId, {
        operation: request.operation,
        resolve,
        reject,
        remove_abort_listener: removeAbortListener,
      });
      options.signal?.addEventListener("abort", abort, { once: true });

      try {
        this.endpoint.postMessage(request);
      } catch (error) {
        this.pending.delete(requestId);
        removeAbortListener();
        reject(error);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endpoint.removeEventListener("message", this.handleMessage);
    this.endpoint.removeEventListener(
      "messageerror",
      this.handleMessageError,
    );
    this.endpoint.close?.();
    this.rejectAll(
      new NativeStorageProtocolError(
        "The native storage connection was closed.",
      ),
    );
  }

  private createUniqueRequestId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const requestId = this.createRequestId();
      if (requestId.length > 0 && !this.pending.has(requestId)) {
        return requestId;
      }
    }
    throw new NativeStorageProtocolError(
      "Could not allocate a unique native storage request id.",
    );
  }

  private readonly handleMessage = (
    event: MessageEvent<unknown>,
  ): void => {
    let response: NativeStorageResponse;
    try {
      response = parseNativeStorageResponse(event.data);
    } catch (error) {
      this.failProtocol(
        new NativeStorageProtocolError(
          toErrorMessage(
            error,
            "The native storage response was invalid.",
          ),
        ),
      );
      return;
    }

    const pending = this.pending.get(response.request_id);
    if (!pending) return;
    this.pending.delete(response.request_id);
    pending.remove_abort_listener();

    if (response.result.kind === "error") {
      pending.reject(
        mapNativeStorageError(
          response.result.error,
          pending.operation.kind,
        ),
      );
      return;
    }

    const expectedKind =
      nativeStorageResultKindByOperation[pending.operation.kind];
    if (response.result.kind !== expectedKind) {
      pending.reject(
        new NativeStorageProtocolError(
          `Native storage returned ${response.result.kind} for ${pending.operation.kind}; expected ${expectedKind}.`,
        ),
      );
      return;
    }
    try {
      validateNativeStorageResultForOperation(
        pending.operation,
        response.result,
      );
    } catch (error) {
      pending.reject(
        new NativeStorageProtocolError(
          toErrorMessage(
            error,
            "Native storage returned a mismatched result.",
          ),
        ),
      );
      return;
    }
    pending.resolve(response.result);
  };

  private readonly handleMessageError = (): void => {
    this.failProtocol(
      new NativeStorageProtocolError(
        "The native storage response could not be decoded.",
      ),
    );
  };

  private failProtocol(error: NativeStorageProtocolError): void {
    if (this.closed) return;
    this.closed = true;
    this.endpoint.removeEventListener("message", this.handleMessage);
    this.endpoint.removeEventListener(
      "messageerror",
      this.handleMessageError,
    );
    this.endpoint.close?.();
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.remove_abort_listener();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function mapNativeStorageError(
  error: NativeStorageError,
  operationKind: NativeStorageOperation["kind"],
): Error {
  switch (error.code) {
    case "project_store_conflict":
      return new ProjectStoreConflictError(error.message);
    case "workspace_already_exists":
      return new WorkspaceBackendError("already_exists", error.message);
    case "workspace_not_found":
      if (isWorkspaceHandleOperation(operationKind)) {
        return new VfsError("not_found", error.message);
      }
      return new WorkspaceBackendError("not_found", error.message);
    case "workspace_corruption":
      return new WorkspaceCorruptionError(error.message);
    case "vfs_invalid_path":
    case "vfs_not_found":
    case "vfs_not_directory":
    case "vfs_is_directory":
    case "vfs_conflict":
      return new VfsError(
        error.code.slice("vfs_".length) as VfsErrorCode,
        error.message,
      );
    case "invalid_request":
    case "internal":
      return new NativeStorageRpcError(error.code, error.message);
  }
}

function isWorkspaceHandleOperation(
  kind: NativeStorageOperation["kind"],
): boolean {
  switch (kind) {
    case "workspace_list":
    case "workspace_read":
    case "workspace_get_path_state":
    case "workspace_read_files_snapshot":
    case "workspace_write":
    case "workspace_remove":
    case "workspace_list_changes":
    case "workspace_get_change":
    case "workspace_revert_change":
      return true;
    default:
      return false;
  }
}

function createDefaultRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function createAbortError(): DOMException {
  return new DOMException("The native storage request was aborted.", "AbortError");
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
