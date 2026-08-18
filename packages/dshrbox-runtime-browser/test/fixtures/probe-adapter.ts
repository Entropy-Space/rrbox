import {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type {
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from "@researchbox/model-transport";

export type ProbeAdapterScript =
  | { kind: "text"; text: string }
  | { kind: "wait_for_cancel"; partial_text: string };

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export class ProbeLlmAdapter extends LlmAdapter {
  private readonly blocked = deferred();
  private readonly script: ProbeAdapterScript;

  constructor(script: ProbeAdapterScript) {
    super();
    this.script = script;
  }

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async waitUntilBlocked(): Promise<void> {
    await this.blocked.promise;
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.script.kind === "text"
      ? this.script.text
      : this.script.partial_text;
    yield { type: "block-start", index: 0, blockType: "text" };
    for (const character of text) {
      if (options.signal?.aborted) throw new Error("probe stream aborted");
      yield { type: "text-delta", index: 0, text: character };
    }

    if (this.script.kind === "wait_for_cancel") {
      this.blocked.resolve();
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => reject(new Error("probe stream aborted"));
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
      });
      return;
    }

    yield {
      type: "block-end",
      index: 0,
      block: { type: "text", text },
    };
    yield {
      type: "usage",
      usage: { inputTokens: 1, outputTokens: text.length },
    };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const WORKSPACE_CALL_ID = "dshrbox-workspace-probe-call";
const WORKSPACE_RESULT_TEXT = "Browser workspace content.";

export class WorkspaceProbeModelTransport implements ModelTransport {
  private requestCount = 0;
  private observedResult = false;

  get didObserveResult(): boolean {
    return this.observedResult;
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    if (signal.aborted) throw new Error("workspace probe stream aborted");
    const requestIndex = this.requestCount;
    this.requestCount += 1;
    if (requestIndex === 0) {
      if (!request.tools.some((tool) => tool.name === "read_file")) {
        throw new Error("workspace probe did not receive the read_file schema");
      }
      yield {
        type: "tool_call_start",
        content_index: 0,
      };
      yield {
        type: "tool_call_delta",
        content_index: 0,
        tool_call_id_delta: WORKSPACE_CALL_ID,
        tool_name_delta: "read_file",
        arguments_delta: JSON.stringify({ path: "/notes.txt" }),
      };
      yield {
        type: "tool_call_end",
        content_index: 0,
        tool_call: {
          tool_call_id: WORKSPACE_CALL_ID,
          tool_name: "read_file",
          arguments: { path: "/notes.txt" },
        },
      };
      yield { type: "done", stop_reason: "tool_use" };
      return;
    }
    if (requestIndex !== 1) {
      throw new Error("workspace probe received an unexpected model request");
    }

    const resultText = findToolResultText(request);
    if (resultText !== WORKSPACE_RESULT_TEXT) {
      throw new Error(
        `workspace probe received unexpected tool content: ${resultText}`,
      );
    }
    this.observedResult = true;
    const text = "Workspace tool result observed.";
    yield { type: "text_start", content_index: 0 };
    yield { type: "text_delta", content_index: 0, text_delta: text };
    yield { type: "text_end", content_index: 0 };
    yield { type: "done", stop_reason: "stop" };
  }
}

function findToolResultText(request: ModelRequest): string | undefined {
  for (const message of request.messages) {
    if (
      message.role === "tool" &&
      message.tool_call_id === WORKSPACE_CALL_ID
    ) {
      return message.content;
    }
  }
  return undefined;
}
