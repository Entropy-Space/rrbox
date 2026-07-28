import type { CoreEvent } from "@researchbox/protocol";

export const CORE_WORKER_CONTROL_VERSION = 1;

export type CoreWorkerDisposeRequest = {
  core_worker_control_version: typeof CORE_WORKER_CONTROL_VERSION;
  type: "dispose";
};

export type CoreWorkerDisposedAck = {
  core_worker_control_version: typeof CORE_WORKER_CONTROL_VERSION;
  type: "disposed";
};

export type CoreWorkerOutboundMessage = CoreEvent | CoreWorkerDisposedAck;

const disposeRequest: CoreWorkerDisposeRequest = Object.freeze({
  core_worker_control_version: CORE_WORKER_CONTROL_VERSION,
  type: "dispose",
});

const disposedAck: CoreWorkerDisposedAck = Object.freeze({
  core_worker_control_version: CORE_WORKER_CONTROL_VERSION,
  type: "disposed",
});

export function createCoreWorkerDisposeRequest(): CoreWorkerDisposeRequest {
  return disposeRequest;
}

export function createCoreWorkerDisposedAck(): CoreWorkerDisposedAck {
  return disposedAck;
}

export function isCoreWorkerDisposeRequest(
  value: unknown,
): value is CoreWorkerDisposeRequest {
  return isControlMessage(value, "dispose");
}

export function isCoreWorkerDisposedAck(
  value: unknown,
): value is CoreWorkerDisposedAck {
  return isControlMessage(value, "disposed");
}

function isControlMessage(
  value: unknown,
  type: CoreWorkerDisposeRequest["type"] | CoreWorkerDisposedAck["type"],
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "core_worker_control_version" in value &&
    value.core_worker_control_version === CORE_WORKER_CONTROL_VERSION &&
    "type" in value &&
    value.type === type
  );
}
