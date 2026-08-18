import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";

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

const WORKSPACE_CALL_ID = CallId("dshrbox-workspace-probe-call");
const WORKSPACE_RESULT_TEXT = "Browser workspace content.";

export class WorkspaceProbeLlmAdapter extends LlmAdapter {
  private requestCount = 0;
  private observedResult = false;

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  get didObserveResult(): boolean {
    return this.observedResult;
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const requestIndex = this.requestCount;
    this.requestCount += 1;
    if (requestIndex === 0) {
      if (!options.tools?.some((tool) => tool.name === "read_file")) {
        throw new Error("workspace probe did not receive the read_file schema");
      }
      const argumentsValue = JSON.stringify({ path: "/notes.txt" });
      yield {
        type: "block-start",
        index: 0,
        blockType: "tool-call",
      };
      yield {
        type: "tool-call-delta",
        index: 0,
        id: WORKSPACE_CALL_ID,
        name: "read_file",
        argumentsDelta: argumentsValue,
      };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: WORKSPACE_CALL_ID,
          name: "read_file",
          arguments: argumentsValue,
        },
      };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (requestIndex !== 1) {
      throw new Error("workspace probe received an unexpected model request");
    }

    const resultText = findToolResultText(options);
    if (resultText !== WORKSPACE_RESULT_TEXT) {
      throw new Error(
        `workspace probe received unexpected tool content: ${resultText}`,
      );
    }
    this.observedResult = true;
    yield* streamText("Workspace tool result observed.", options.signal);
  }
}

function findToolResultText(options: GenerateOptions): string | undefined {
  for (const message of options.messages) {
    for (const block of message.content) {
      if (
        block.type !== "tool-result" ||
        block.toolCallId !== WORKSPACE_CALL_ID
      ) {
        continue;
      }
      return block.content
        .flatMap((content) => content.type === "text" ? [content.text] : [])
        .join("");
    }
  }
  return undefined;
}

async function* streamText(
  text: string,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  for (const character of text) {
    if (signal?.aborted) throw new Error("probe stream aborted");
    yield { type: "text-delta", index: 0, text: character };
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
