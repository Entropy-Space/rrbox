import AgentRegistry, { type Agent } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import {
  Context,
  Service,
  type Plugin,
} from "@deepseek-ai/cordis";
import LlmRuntime, {
  type LlmAdapter,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import SessionStore, {
  SessionId,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

export { dshrboxToolCallBlockId } from "./identity.ts";

export type { SessionEvent } from "@deepseek-ai/dsh-session";

export type DshrboxRuntimeConfig = {
  llm_adapter: LlmAdapter;
  model: string;
  provider: string;
  session_id: string;
  resume?: boolean;
};

export type DshrboxSessionEventListener = (event: SessionEvent) => void;

declare module "@deepseek-ai/cordis" {
  interface Context {
    dshrbox: DshrboxRuntime;
  }
}

/**
 * The first dshrbox-owned DSH plugin. It owns one serialized agent runtime and
 * intentionally exposes DSH session events without projecting them.
 */
export class DshrboxRuntime extends Service {
  static inject = ["agents", "agentLoop", "llm", "sessions"];

  private active = false;
  private disposed = false;
  private readonly agentPromise: Promise<Agent>;
  private liveAgent: Agent | undefined;

  constructor(ctx: Context, config: DshrboxRuntimeConfig) {
    super(ctx, "dshrbox");
    ctx.llm.registerAdapter([config.provider], config.llm_adapter);
    const agentOptions = {
      model: config.model,
      provider: config.provider,
    };
    const handlePromise = config.resume === true
      ? ctx.agents.resume({
          resumeSessionId: SessionId(config.session_id),
          agentOptions,
        })
      : ctx.agents.create({
          sessionId: SessionId(config.session_id),
          agentOptions,
        });
    this.agentPromise = handlePromise.then((handle) => {
      this.liveAgent = handle.agent;
      return handle.agent;
    });
    ctx.effect(() => () => {
      this.disposed = true;
      this.liveAgent = undefined;
    }, "dshrbox.lifecycle()");
  }

  async ready(): Promise<void> {
    await this.agentPromise;
  }

  get agent(): Agent {
    if (this.liveAgent === undefined) {
      throw new Error("dshrbox runtime is not ready");
    }
    return this.liveAgent;
  }

  subscribe(listener: DshrboxSessionEventListener): () => void {
    const agent = this.agent;
    return this.ctx.on("session/event", (session, event) => {
      if (session === agent.session) listener(event);
    });
  }

  async run(prompt: string): Promise<void> {
    if (this.disposed) throw new Error("dshrbox runtime is disposed");
    if (this.active) {
      throw new Error("dshrbox runtime already has an active run");
    }
    this.active = true;
    try {
      const agent = await this.agentPromise;
      agent.followup(createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();
    } finally {
      this.active = false;
    }
  }

  cancel(): void {
    this.agent.cancel({ kind: "user" });
  }
}

export default DshrboxRuntime;

export type CreateDshrboxCoreOptions = DshrboxRuntimeConfig & {
  max_parallel_tool_calls?: number;
  persona?: string;
  plugins?: readonly DshrboxPluginRegistration[];
};

export type DshrboxPluginRegistration = Readonly<{
  plugin: Plugin;
  config?: unknown;
}>;

export type DshrboxCore = {
  context: Context;
  dispose(): Promise<void>;
  runtime: DshrboxRuntime;
};

/** Compose the official DSH services and the dshrbox runtime plugin. */
export async function createDshrboxCore(
  options: CreateDshrboxCoreOptions,
): Promise<DshrboxCore> {
  const context = new Context();
  const {
    max_parallel_tool_calls,
    persona,
    plugins = [],
    ...runtimeOptions
  } = options;
  try {
    await context.plugin(LlmRuntime);
    await context.plugin(SessionStore);
    await context.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      ...(persona === undefined ? {} : { persona }),
    });
    await context.plugin(ToolRuntime, { mode: "native" });
    await context.plugin(AgentRegistry);
    await context.plugin(AgentLoop, {
      agents: [],
      ...(max_parallel_tool_calls === undefined
        ? {}
        : { maxParallelToolCalls: max_parallel_tool_calls }),
    });
    for (const registration of plugins) {
      await context.plugin(registration.plugin, registration.config);
    }
    await context.plugin(DshrboxRuntime, runtimeOptions);
    await context.dshrbox.ready();
    return {
      context,
      dispose: () => context.fiber.dispose(),
      runtime: context.dshrbox,
    };
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
}
