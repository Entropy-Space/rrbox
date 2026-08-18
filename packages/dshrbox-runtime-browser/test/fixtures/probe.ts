import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { createDshrboxBrowserCore } from "../../src/index.ts";
import { ProbeLlmAdapter } from "./probe-adapter.ts";

const DSH_VERSION = "0.1.0-rc.6";
const PROBE_PROVIDER = "dshrbox-probe";
const PROBE_MODEL = "fake-streaming-model";

export type DshrboxProbeTurn = {
  event_types: string[];
  text: string;
  turn_end_kind: string;
};

export type DshrboxBrowserProbeResult = {
  cancellation: DshrboxProbeTurn;
  dsh_version: string;
  ok: boolean;
  streaming: DshrboxProbeTurn;
};

function projectProbeTurn(events: SessionEvent[]): DshrboxProbeTurn {
  const text = events.flatMap((event) => {
    if (
      event.type === "assistant/chunk" &&
      event.data.chunk.type === "text-delta"
    ) {
      return [event.data.chunk.text];
    }
    return [];
  }).join("");
  const turnEnd = events.findLast((event) => event.type === "turn/end");
  return {
    event_types: events.map((event) => event.type),
    text,
    turn_end_kind: turnEnd?.type === "turn/end"
      ? turnEnd.data.reason.kind
      : "missing",
  };
}

async function runStreamingProbe(): Promise<DshrboxProbeTurn> {
  const adapter = new ProbeLlmAdapter({
    kind: "text",
    text: "DSH streams in a browser worker.",
  });
  const core = await createDshrboxBrowserCore({
    llm_adapter: adapter,
    model: PROBE_MODEL,
    provider: PROBE_PROVIDER,
    session_id: "dshrbox-streaming-probe",
  });
  const events: SessionEvent[] = [];
  const unsubscribe = core.runtime.subscribe((event) => events.push(event));
  try {
    await core.runtime.run("Prove streaming.");
    return projectProbeTurn(events);
  } finally {
    unsubscribe();
    await core.dispose();
  }
}

async function runCancellationProbe(): Promise<DshrboxProbeTurn> {
  const adapter = new ProbeLlmAdapter({
    kind: "wait_for_cancel",
    partial_text: "partial",
  });
  const core = await createDshrboxBrowserCore({
    llm_adapter: adapter,
    model: PROBE_MODEL,
    provider: PROBE_PROVIDER,
    session_id: "dshrbox-cancellation-probe",
  });
  const events: SessionEvent[] = [];
  const unsubscribe = core.runtime.subscribe((event) => events.push(event));
  try {
    const run = core.runtime.run("Prove cancellation.");
    await adapter.waitUntilBlocked();
    core.runtime.cancel();
    await run;
    return projectProbeTurn(events);
  } finally {
    unsubscribe();
    await core.dispose();
  }
}

export async function runDshrboxBrowserProbe(): Promise<DshrboxBrowserProbeResult> {
  const streaming = await runStreamingProbe();
  const cancellation = await runCancellationProbe();
  return {
    cancellation,
    dsh_version: DSH_VERSION,
    ok: streaming.turn_end_kind === "completed" &&
      cancellation.turn_end_kind === "aborted",
    streaming,
  };
}
