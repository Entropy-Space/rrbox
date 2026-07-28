import {
  parseViewerCommand,
  type ViewerCommand,
} from "@researchbox/protocol";
import {
  createCoreWorkerDisposedAck,
  isCoreWorkerDisposeRequest,
  type CoreWorkerOutboundMessage,
} from "./core-worker-lifecycle.ts";

export interface CoreCommandHandler {
  handle(command: ViewerCommand): Promise<void>;
  reportHostError(
    code: "invalid_command" | "command_failed",
    message: string,
    requestId?: string,
  ): void;
  dispose?(): void | Promise<void>;
}

export interface WorkerHost {
  onmessage: ((message: MessageEvent<unknown>) => void) | null;
  postMessage(message: CoreWorkerOutboundMessage): void;
}

export function attachWorkerHost(
  host: WorkerHost,
  core: CoreCommandHandler,
): void {
  host.onmessage = (message) => {
    let command: ViewerCommand;
    try {
      command = parseViewerCommand(message.data);
    } catch (error) {
      core.reportHostError(
        "invalid_command",
        toErrorMessage(error, "Invalid command."),
      );
      return;
    }

    void core.handle(command).catch((error: unknown) => {
      core.reportHostError(
        "command_failed",
        toErrorMessage(error, "The browser core could not handle the command."),
        command.request_id,
      );
    });
  };
}

export function attachCoreWorkerLifecycle(
  host: WorkerHost,
  dispose: () => void | Promise<void>,
): void {
  const handleCommand = host.onmessage;
  let disposal: Promise<void> | null = null;

  host.onmessage = (message) => {
    if (!isCoreWorkerDisposeRequest(message.data)) {
      handleCommand?.(message);
      return;
    }

    if (!disposal) {
      disposal = Promise.resolve().then(dispose);
    }
    void disposal.then(
      () => host.postMessage(createCoreWorkerDisposedAck()),
      () => host.postMessage(createCoreWorkerDisposedAck()),
    );
  };
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
