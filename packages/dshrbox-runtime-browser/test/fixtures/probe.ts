import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import DshrboxEventProjection from "@dshrbox/event-projector";
import { ModelTransportLlmAdapter } from "@dshrbox/model-adapter";
import { MemoryDshrboxSessionBackend } from "@dshrbox/session-persistence";
import { DshrboxSessionRuntimeProvider } from "@dshrbox/session-runtime";
import DshrboxWorkspace from "@dshrbox/workspace";
import { ResearchBoxCore } from "@researchbox/agent-core";
import { MemoryProjectStore } from "@researchbox/project-store";
import { createCommand } from "@researchbox/protocol";
import {
  MemoryFileSystem,
  MemoryWorkspace,
  MemoryWorkspaceBackend,
} from "@researchbox/vfs";
import { createDshrboxBrowserCore } from "../../src/index.ts";
import {
  ProbeLlmAdapter,
  WorkspaceProbeModelTransport,
} from "./probe-adapter.ts";

const DSH_VERSION = "0.1.0-rc.7";
const PROBE_PROJECT_ID = "dshrbox-browser-probe-project";
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
  session_runtime: DshrboxSessionRuntimeProbe;
  workspace: DshrboxWorkspaceProbe;
};

export type DshrboxSessionRuntimeProbe = {
  persisted_event_count: number;
  runtime_id: string;
  timeline_types: string[];
};

export type DshrboxWorkspaceProbe = {
  event_types: string[];
  model_observed_result: boolean;
  projected_event_types: string[];
  projected_timeline_types: string[];
  result_text: string;
  tool_name: string;
  turn_end_kind: string;
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

async function runWorkspaceProbe(): Promise<DshrboxWorkspaceProbe> {
  const transport = new WorkspaceProbeModelTransport();
  const adapter = new ModelTransportLlmAdapter(transport);
  const projectedEvents: Array<{ type: string }> = [];
  const core = await createDshrboxBrowserCore({
    llm_adapter: adapter,
    model: PROBE_MODEL,
    plugins: [{
      plugin: DshrboxEventProjection,
      config: {
        project_id: PROBE_PROJECT_ID,
        session_id: "dshrbox-workspace-probe",
        event_sink: (event: { type: string }) => projectedEvents.push(event),
      },
    }, {
      plugin: DshrboxWorkspace,
      config: {
        workspace: new MemoryWorkspace({
          "/notes.txt": "Browser workspace content.",
        }),
      },
    }],
    provider: PROBE_PROVIDER,
    session_id: "dshrbox-workspace-probe",
  });
  const events: SessionEvent[] = [];
  const unsubscribe = core.runtime.subscribe((event) => events.push(event));
  try {
    await core.runtime.run("Read the workspace note.");
    const toolCall = events.find((event) => event.type === "tool/call");
    const toolResult = events.find((event) => event.type === "tool/result");
    const resultText = toolResult?.type === "tool/result"
      ? toolResult.data.message.content
        .flatMap((block) => block.type === "tool-result"
          ? block.content.flatMap((content) =>
            content.type === "text" ? [content.text] : []
          )
          : [])
        .join("")
      : "";
    const turnEnd = events.findLast((event) => event.type === "turn/end");
    return {
      event_types: events.map((event) => event.type),
      model_observed_result: transport.didObserveResult,
      projected_event_types: projectedEvents.map((event) => event.type),
      projected_timeline_types: core.context.dshrboxProjection
        .snapshot().timeline.map((entry) => entry.type),
      result_text: resultText,
      tool_name: toolCall?.type === "tool/call"
        ? toolCall.data.name
        : "missing",
      turn_end_kind: turnEnd?.type === "turn/end"
        ? turnEnd.data.reason.kind
        : "missing",
    };
  } finally {
    unsubscribe();
    await core.dispose();
  }
}

async function runSessionRuntimeProbe(): Promise<DshrboxSessionRuntimeProbe> {
  const projectStore = new MemoryProjectStore();
  const sessionBackend = new MemoryDshrboxSessionBackend();
  const workspaceBackend = new MemoryWorkspaceBackend(
    () => new MemoryFileSystem({
      "/notes.txt": "Browser workspace content.",
    }),
  );
  const transport = new WorkspaceProbeModelTransport();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const model = {
    id: PROBE_MODEL,
    name: "DSH browser probe",
    api: "openai-completions",
    provider: PROBE_PROVIDER,
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  };
  const core = new ResearchBoxCore({
    projectStore,
    workspaceBackend,
    modelTransport: transport,
    model,
    systemPrompt: "Run the DSH browser session probe.",
    eventSink: (event) => events.push(event),
    sessionRuntimeProvider: new DshrboxSessionRuntimeProvider({
      session_backend: sessionBackend,
      max_parallel_tool_calls: 1,
      write_batch_max_delay_ms: 1,
    }),
  });
  try {
    await core.handle(createCommand("bootstrap", {}));
    const ready = events.findLast((event) => event.type === "ready");
    if (ready?.type !== "ready") throw new Error("Missing probe ready event.");
    const state = ready.payload.state as {
      active_project_id: string;
    };
    await core.handle(createCommand("prompt", {
      project_id: state.active_project_id,
      session_id: null,
      text: "Read the browser workspace note.",
    }));
    const stored = await projectStore.load();
    const document = stored?.documents[0];
    if (document?.format_version !== 6) {
      throw new Error("Missing browser DSH runtime reference.");
    }
    const persisted = await sessionBackend.loadStored(
      SessionId(document.session_id),
    );
    const snapshot = events.findLast((event) =>
      event.type === "state_snapshot"
    )?.payload.state as { timeline?: Array<{ type: string }> } | undefined;
    return {
      persisted_event_count: persisted?.events.length ?? 0,
      runtime_id: document.runtime_id,
      timeline_types: snapshot?.timeline?.map((entry) => entry.type) ?? [],
    };
  } finally {
    await core.dispose();
  }
}

export async function runDshrboxBrowserProbe(): Promise<DshrboxBrowserProbeResult> {
  const streaming = await runStreamingProbe();
  const cancellation = await runCancellationProbe();
  const workspace = await runWorkspaceProbe();
  const sessionRuntime = await runSessionRuntimeProbe();
  return {
    cancellation,
    dsh_version: DSH_VERSION,
    ok: streaming.turn_end_kind === "completed" &&
      cancellation.turn_end_kind === "aborted" &&
      workspace.turn_end_kind === "completed" &&
      workspace.model_observed_result &&
      sessionRuntime.runtime_id === "dsh",
    session_runtime: sessionRuntime,
    streaming,
    workspace,
  };
}
