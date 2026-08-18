import {
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
