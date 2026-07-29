import type { CoreEvent, ViewerCommand } from "@researchbox/protocol";

export type CoreTransportFailure =
  | "invalid_event"
  | "transport_error";

export type CoreEventListener = (event: CoreEvent) => void;
export type CoreFailureListener = (failure: CoreTransportFailure) => void;

/**
 * Platform-neutral connection between a viewer and the rrbox core.
 *
 * Implementations validate events before delivering them and must make
 * `close` idempotent so teardown remains safe after a transport failure.
 */
export interface CoreTransport {
  send(command: ViewerCommand): void;
  subscribe(
    onEvent: CoreEventListener,
    onFailure: CoreFailureListener,
  ): () => void;
  close(): void;
}

export type CoreTransportFactory = () => CoreTransport;
