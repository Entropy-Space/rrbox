import {
  parseViewerCommand,
  type CoreEvent,
  type ViewerCommand,
} from "@researchbox/protocol";

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
  postMessage(event: CoreEvent): void;
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

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
