import { Context, Service } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { CoreEvent } from "@researchbox/protocol";
import {
  DshrboxEventProjector,
  type DshrboxEventProjectorOptions,
  type DshrboxProjectionSnapshot,
} from "./projector.ts";

export type DshrboxEventProjectionConfig = DshrboxEventProjectorOptions & {
  event_sink(event: CoreEvent): void;
  seed_events?: readonly SessionEvent[];
};

declare module "@deepseek-ai/cordis" {
  interface Context {
    dshrboxProjection: DshrboxEventProjection;
  }
}

/** DSH plugin that projects one session's event firehose for a host viewer. */
export class DshrboxEventProjection extends Service {
  static inject = ["sessions"];

  readonly projector: DshrboxEventProjector;

  constructor(ctx: Context, config: DshrboxEventProjectionConfig) {
    assertProjectionConfig(config);
    super(ctx, "dshrboxProjection");
    this.projector = new DshrboxEventProjector(config);
    if (config.seed_events !== undefined) {
      this.projector.replay(config.seed_events);
    }
    ctx.on("session/event", (session, event) => {
      if (String(session.id) !== config.session_id) return;
      if (this.projector.last_event_seq === null && event.seq > 0) {
        this.projector.replay(session.events.slice(0, event.seq));
      }
      for (const projected of this.projector.accept(event)) {
        config.event_sink(projected);
      }
    });
  }

  snapshot(): DshrboxProjectionSnapshot {
    return this.projector.snapshot();
  }
}

export default DshrboxEventProjection;

function assertProjectionConfig(
  config: DshrboxEventProjectionConfig,
): void {
  if (config === null || typeof config !== "object") {
    throw new TypeError("dshrbox event projection config must be an object");
  }
  if (typeof config.event_sink !== "function") {
    throw new TypeError("dshrbox event projection requires an event_sink");
  }
}
