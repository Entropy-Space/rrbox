import type { WorkspaceTransferAdapter } from "@researchbox/viewer";
import {
  BROWSER_WORKSPACE_ARCHIVE_LIMITS,
} from "@researchbox/app-runtime-browser/workspace-transfer-limits";
import {
  ArchiveWorkerProtocolError,
  createDecodeWorkspaceArchiveRequest,
  createEncodeWorkspaceArchiveRequest,
  parseArchiveWorkerResponse,
  type ArchiveWorkerErrorCode,
  type ArchiveWorkerRequest,
  type DecodeWorkspaceArchiveRequest,
  type EncodeWorkspaceArchiveRequest,
  type WorkspaceArchiveDecodedResponse,
  type WorkspaceArchiveEncodedResponse,
} from "./archive-worker-protocol.ts";

type WorkspaceTransferFile = Parameters<
  WorkspaceTransferAdapter["downloadWorkspaceExport"]
>[0]["files"][number];

type ArchiveWorkerLike = {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
};

type FileReaderLike = {
  readonly error: DOMException | null;
  readonly result: string | ArrayBuffer | null;
  abort(): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  readAsArrayBuffer(blob: Blob): void;
};

export type BrowserWorkspaceTransferDependencies = {
  createArchiveWorker?: () => ArchiveWorkerLike;
  createFileReader?: () => FileReaderLike;
  getDocument?: () => Document;
  getWindow?: () => Window;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  scheduleObjectUrlRevocation?: (callback: () => void) => void;
};

const PROJECT_NAME_MAX_LENGTH = 80;
const WORKSPACE_ARCHIVE_URL_REVOCATION_DELAY_MS = 60_000;
export const WORKSPACE_ARCHIVE_WORKER_TIMEOUT_MS = 120_000;
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const UNSAFE_NAME_CHARACTERS =
  /[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/gu;

export class BrowserWorkspaceTransferAdapter
  implements WorkspaceTransferAdapter
{
  readonly #dependencies: Required<BrowserWorkspaceTransferDependencies>;

  constructor(dependencies: BrowserWorkspaceTransferDependencies = {}) {
    const getWindow = dependencies.getWindow ?? requireBrowserWindow;
    this.#dependencies = {
      createArchiveWorker:
        dependencies.createArchiveWorker ?? createWorkspaceArchiveWorker,
      createFileReader:
        dependencies.createFileReader ?? (() => new FileReader()),
      getDocument: dependencies.getDocument ?? requireBrowserDocument,
      getWindow,
      createObjectUrl:
        dependencies.createObjectUrl ?? ((blob) => URL.createObjectURL(blob)),
      revokeObjectUrl:
        dependencies.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url)),
      scheduleObjectUrlRevocation:
        dependencies.scheduleObjectUrlRevocation ??
        ((callback) => {
          scheduleWorkspaceArchiveUrlRevocation(getWindow(), callback);
        }),
    };
  }

  async pickWorkspaceImport(options: {
    signal: AbortSignal;
  }): Promise<{
    suggested_name: string;
    files: WorkspaceTransferFile[];
  } | null> {
    const file = await pickWorkspaceArchiveFile(
      this.#dependencies.getDocument(),
      options.signal,
    );
    if (!file) return null;
    assertArchiveFileSize(file);

    const archiveBytes = await readFileAsArrayBuffer(
      file,
      options.signal,
      this.#dependencies.createFileReader,
    );
    const response = await runArchiveWorker(
      this.#dependencies.createArchiveWorker,
      createDecodeWorkspaceArchiveRequest(archiveBytes),
      options.signal,
    );
    return {
      suggested_name: deriveWorkspaceProjectName(file.name),
      files: response.files,
    };
  }

  async downloadWorkspaceExport(options: {
    suggested_name: string;
    files: WorkspaceTransferFile[];
    signal: AbortSignal;
  }): Promise<void> {
    const response = await runArchiveWorker(
      this.#dependencies.createArchiveWorker,
      createEncodeWorkspaceArchiveRequest(options.files),
      options.signal,
    );
    throwIfAborted(options.signal);
    triggerWorkspaceArchiveDownload({
      archive_bytes: response.archive_bytes,
      file_name: createWorkspaceArchiveFileName(options.suggested_name),
      signal: options.signal,
      document: this.#dependencies.getDocument(),
      create_object_url: this.#dependencies.createObjectUrl,
      revoke_object_url: this.#dependencies.revokeObjectUrl,
      schedule_object_url_revocation:
        this.#dependencies.scheduleObjectUrlRevocation,
    });
  }
}

export function createWorkspaceArchiveWorker(): Worker {
  return new Worker(new URL("./archive.worker.ts", import.meta.url), {
    type: "module",
    name: "researchbox-workspace-archive",
  });
}

export function scheduleWorkspaceArchiveUrlRevocation(
  browserWindow: Pick<Window, "setTimeout">,
  callback: () => void,
): void {
  browserWindow.setTimeout(
    callback,
    WORKSPACE_ARCHIVE_URL_REVOCATION_DELAY_MS,
  );
}

export function runArchiveWorker(
  createWorker: () => ArchiveWorkerLike,
  request: DecodeWorkspaceArchiveRequest,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<WorkspaceArchiveDecodedResponse>;
export function runArchiveWorker(
  createWorker: () => ArchiveWorkerLike,
  request: EncodeWorkspaceArchiveRequest,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<WorkspaceArchiveEncodedResponse>;
export function runArchiveWorker(
  createWorker: () => ArchiveWorkerLike,
  request: ArchiveWorkerRequest,
  signal: AbortSignal,
  timeoutMs = WORKSPACE_ARCHIVE_WORKER_TIMEOUT_MS,
): Promise<
  WorkspaceArchiveDecodedResponse | WorkspaceArchiveEncodedResponse
> {
  throwIfAborted(signal);
  const worker = createWorker();
  if (signal.aborted) {
    worker.terminate();
    throw createAbortError();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      signal.removeEventListener("abort", handleAbort);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.removeEventListener("messageerror", handleMessageError);
      worker.terminate();
    };
    const settle = (
      operation: () => void,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const handleAbort: EventListener = () => {
      settle(() => reject(createAbortError()));
    };
    const handleMessage: EventListener = (event) => {
      try {
        const response = parseArchiveWorkerResponse(
          (event as MessageEvent<unknown>).data,
        );
        if (response.type === "workspace_archive_error") {
          settle(() => {
            reject(
              new WorkspaceArchiveWorkerError(
                response.error_code,
                response.error_message,
              ),
            );
          });
          return;
        }
        const expectedType =
          request.type === "decode_workspace_archive"
            ? "workspace_archive_decoded"
            : "workspace_archive_encoded";
        if (response.type !== expectedType) {
          throw new ArchiveWorkerProtocolError(
            `Workspace archive worker returned ${response.type}; expected ${expectedType}.`,
          );
        }
        settle(() => resolve(response));
      } catch (error) {
        settle(() => reject(toError(error)));
      }
    };
    const handleError: EventListener = (event) => {
      const workerError = event as ErrorEvent;
      workerError.preventDefault();
      settle(() => {
        reject(
          new Error(
            workerError.message ||
              "The workspace archive worker encountered an error.",
          ),
        );
      });
    };
    const handleMessageError: EventListener = () => {
      settle(() => {
        reject(
          new ArchiveWorkerProtocolError(
            "The workspace archive worker returned an unreadable response.",
          ),
        );
      });
    };
    const handleTimeout = () => {
      settle(() => {
        reject(
          new WorkspaceArchiveWorkerError(
            "archive_worker_failed",
            "The workspace archive operation timed out.",
          ),
        );
      });
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.addEventListener("messageerror", handleMessageError);
    timeoutId = setTimeout(
      handleTimeout,
      timeoutMs,
    );
    if (signal.aborted) {
      handleAbort(new Event("abort"));
      return;
    }

    try {
      const transfer =
        request.type === "decode_workspace_archive"
          ? [request.archive_bytes]
          : [];
      worker.postMessage(request, transfer);
    } catch (error) {
      settle(() => reject(toError(error)));
    }
  });
}

export class WorkspaceArchiveWorkerError extends Error {
  public readonly error_code: ArchiveWorkerErrorCode;

  constructor(errorCode: ArchiveWorkerErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceArchiveWorkerError";
    this.error_code = errorCode;
  }
}

export function deriveWorkspaceProjectName(fileName: string): string {
  return sanitizeWorkspaceName(fileName, "Imported workspace");
}

export function createWorkspaceArchiveFileName(
  suggestedName: string,
): string {
  const baseName = sanitizeWorkspaceName(suggestedName, "workspace");
  return `${baseName}.researchbox.zip`;
}

export function pickWorkspaceArchiveFile(
  browserDocument: Document,
  signal: AbortSignal,
): Promise<File | null> {
  throwIfAborted(signal);
  const input = browserDocument.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.multiple = false;
  input.value = "";
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  Object.assign(input.style, {
    position: "fixed",
    inlineSize: "1px",
    blockSize: "1px",
    insetInlineStart: "-10000px",
    opacity: "0",
    pointerEvents: "none",
  });
  browserDocument.body.append(input);

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
      input.removeEventListener("change", handleChange);
      input.removeEventListener("cancel", handleCancel);
      input.remove();
    };
    const settle = (file: File | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort: EventListener = () => fail(createAbortError());
    const handleChange: EventListener = () => settle(firstFile(input.files));
    const handleCancel: EventListener = () => settle(null);

    signal.addEventListener("abort", handleAbort, { once: true });
    input.addEventListener("change", handleChange);
    input.addEventListener("cancel", handleCancel);
    if (signal.aborted) {
      handleAbort(new Event("abort"));
      return;
    }

    try {
      input.click();
    } catch (error) {
      fail(toError(error));
    }
  });
}

export function readFileAsArrayBuffer(
  file: File,
  signal: AbortSignal,
  createReader: () => FileReaderLike = () => new FileReader(),
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const reader = createReader();

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", handleRequestAbort);
      reader.removeEventListener("load", handleLoad);
      reader.removeEventListener("error", handleReadError);
      reader.removeEventListener("abort", handleReaderAbort);
    };
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const handleRequestAbort: EventListener = () => {
      settle(() => {
        try {
          reader.abort();
        } catch {
          // The abort result remains authoritative even if a custom reader
          // reports that it had already stopped.
        }
        reject(createAbortError());
      });
    };
    const handleLoad: EventListener = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        settle(() => {
          reject(new Error("The selected workspace could not be read."));
        });
        return;
      }
      settle(() => resolve(reader.result as ArrayBuffer));
    };
    const handleReadError: EventListener = () => {
      settle(() => {
        reject(
          new Error(
            reader.error?.message ||
              "The selected workspace could not be read.",
          ),
        );
      });
    };
    const handleReaderAbort: EventListener = () => {
      settle(() => reject(createAbortError()));
    };

    signal.addEventListener("abort", handleRequestAbort, { once: true });
    reader.addEventListener("load", handleLoad);
    reader.addEventListener("error", handleReadError);
    reader.addEventListener("abort", handleReaderAbort);
    if (signal.aborted) {
      handleRequestAbort(new Event("abort"));
      return;
    }

    try {
      reader.readAsArrayBuffer(file);
    } catch (error) {
      settle(() => reject(toError(error)));
    }
  });
}

export function triggerWorkspaceArchiveDownload(options: {
  archive_bytes: ArrayBuffer;
  file_name: string;
  signal: AbortSignal;
  document: Document;
  create_object_url: (blob: Blob) => string;
  revoke_object_url: (url: string) => void;
  schedule_object_url_revocation: (callback: () => void) => void;
}): void {
  throwIfAborted(options.signal);
  const blob = new Blob([options.archive_bytes], {
    type: "application/zip",
  });
  const objectUrl = options.create_object_url(blob);
  let anchor: HTMLAnchorElement | null = null;
  let clickSucceeded = false;

  try {
    throwIfAborted(options.signal);
    anchor = options.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = options.file_name;
    anchor.hidden = true;
    options.document.body.append(anchor);
    anchor.click();
    clickSucceeded = true;
  } finally {
    try {
      anchor?.remove();
    } finally {
      if (!clickSucceeded) {
        options.revoke_object_url(objectUrl);
      } else {
        try {
          options.schedule_object_url_revocation(() => {
            options.revoke_object_url(objectUrl);
          });
        } catch {
          options.revoke_object_url(objectUrl);
        }
      }
    }
  }
}

function assertArchiveFileSize(file: File): void {
  const maximum = BROWSER_WORKSPACE_ARCHIVE_LIMITS.max_archive_bytes;
  if (file.size <= maximum) return;
  const maximumMebibytes = maximum / (1024 * 1024);
  throw new Error(
    `Workspace archive exceeds the ${maximumMebibytes} MiB import limit.`,
  );
}

function sanitizeWorkspaceName(value: string, fallback: string): string {
  let name = stripWorkspaceArchiveExtension(value.normalize("NFC").trim())
    .replace(UNSAFE_NAME_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  if (WINDOWS_DEVICE_NAME.test(name)) name = `_${name}`;
  name = truncateWithoutSplittingSurrogate(name, PROJECT_NAME_MAX_LENGTH)
    .trim()
    .replace(/[.\s]+$/gu, "");
  return name || fallback;
}

function stripWorkspaceArchiveExtension(value: string): string {
  return value
    .replace(/\.researchbox\.zip$/iu, "")
    .replace(/\.zip$/iu, "");
}

function truncateWithoutSplittingSurrogate(
  value: string,
  maximumLength: number,
): string {
  if (value.length <= maximumLength) return value;
  let result = value.slice(0, maximumLength);
  const lastCodeUnit = result.charCodeAt(result.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    result = result.slice(0, -1);
  }
  return result;
}

function firstFile(files: FileList | null): File | null {
  if (!files || files.length === 0) return null;
  return files.item(0) ?? files[0] ?? null;
}

function requireBrowserDocument(): Document {
  if (typeof document === "undefined") {
    throw new Error("Workspace transfer requires a browser document.");
  }
  return document;
}

function requireBrowserWindow(): Window {
  if (typeof window === "undefined") {
    throw new Error("Workspace transfer requires a browser window.");
  }
  return window;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

function createAbortError(): DOMException {
  return new DOMException(
    "The workspace transfer was aborted.",
    "AbortError",
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
