/// <reference lib="webworker" />

import { AgentCore } from "./agent-core";
import { MockModelTransport } from "./mock-model-transport";
import { parseViewerCommand } from "../protocol";
import { createSeededFileSystem } from "../vfs";

const core = new AgentCore(
  createSeededFileSystem(),
  new MockModelTransport(),
  (event) => self.postMessage(event),
);

self.onmessage = (message: MessageEvent<unknown>) => {
  try {
    const command = parseViewerCommand(message.data);
    void core.handle(command);
  } catch (error) {
    core.reportProtocolError(
      error instanceof Error ? error.message : "Invalid command.",
    );
  }
};

export {};
