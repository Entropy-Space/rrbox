import "../../src/disposable-symbols.ts";
import {
  runDshrboxBrowserProbe,
  type DshrboxBrowserProbeResult,
} from "./probe.ts";

export { runDshrboxBrowserProbe } from "./probe.ts";

type ProbeRequest = {
  request_id: string;
  type: "run_probe";
};

type ProbeResponse = {
  request_id: string;
  result?: DshrboxBrowserProbeResult;
  error?: string;
  type: "probe_result";
};

type WorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ProbeRequest>) => void,
  ): void;
  postMessage(message: ProbeResponse): void;
};

const workerScope = globalThis as unknown as Partial<WorkerScope>;
if (
  typeof workerScope.addEventListener === "function" &&
  typeof workerScope.postMessage === "function"
) {
  workerScope.addEventListener("message", (event) => {
    if (event.data.type !== "run_probe") return;
    void runDshrboxBrowserProbe().then(
      (result) => workerScope.postMessage?.({
        request_id: event.data.request_id,
        result,
        type: "probe_result",
      }),
      (error: unknown) => workerScope.postMessage?.({
        error: error instanceof Error ? error.message : String(error),
        request_id: event.data.request_id,
        type: "probe_result",
      }),
    );
  });
}
