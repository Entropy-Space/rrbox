/// <reference lib="webworker" />

import {
  decodeWorkspaceArchive,
  encodeWorkspaceArchive,
  WorkspaceArchiveError,
} from "@researchbox/workspace-archive";
import {
  ARCHIVE_WORKER_PROTOCOL_VERSION,
  ArchiveWorkerProtocolError,
  parseArchiveWorkerRequest,
  type ArchiveWorkerErrorCode,
  type ArchiveWorkerResponse,
} from "./archive-worker-protocol.ts";
import { BROWSER_WORKSPACE_ARCHIVE_OPTIONS } from "./workspace-transfer-limits.ts";

const host = self as unknown as DedicatedWorkerGlobalScope;

host.addEventListener(
  "message",
  (event: MessageEvent<unknown>) => {
    let response: ArchiveWorkerResponse;
    let transfer: Transferable[] = [];

    try {
      const request = parseArchiveWorkerRequest(event.data);
      if (request.type === "decode_workspace_archive") {
        const snapshot = decodeWorkspaceArchive(
          request.archive_bytes,
          BROWSER_WORKSPACE_ARCHIVE_OPTIONS,
        );
        response = {
          protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
          type: "workspace_archive_decoded",
          files: snapshot.files,
        };
      } else {
        const archiveBytes = encodeWorkspaceArchive(
          {
            files: request.files,
          },
          BROWSER_WORKSPACE_ARCHIVE_OPTIONS,
        );
        const archiveBuffer = toTransferableArrayBuffer(archiveBytes);
        response = {
          protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
          type: "workspace_archive_encoded",
          archive_bytes: archiveBuffer,
        };
        transfer = [archiveBuffer];
      }
    } catch (error) {
      response = {
        protocol_version: ARCHIVE_WORKER_PROTOCOL_VERSION,
        type: "workspace_archive_error",
        error_code: errorCode(error),
        error_message: errorMessage(error),
      };
    }

    host.postMessage(response, transfer);
    host.close();
  },
  { once: true },
);

function toTransferableArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

function errorCode(error: unknown): ArchiveWorkerErrorCode {
  if (error instanceof WorkspaceArchiveError) return error.code;
  if (error instanceof ArchiveWorkerProtocolError) {
    return "invalid_worker_message";
  }
  return "archive_worker_failed";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The workspace archive worker failed.";
}

export {};
