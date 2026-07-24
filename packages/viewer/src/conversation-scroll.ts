export const CONVERSATION_END_THRESHOLD_PX = 64;

export type ConversationScrollMetrics = {
  scroll_top: number;
  scroll_height: number;
  client_height: number;
};

export type ConversationScrollState = {
  is_following_latest: boolean;
};

export type ConversationScrollEvent =
  | {
      type: "viewport_scrolled";
      metrics: ConversationScrollMetrics;
    }
  | { type: "timeline_changed" }
  | { type: "jump_requested" }
  | { type: "layout_change_requested" }
  | { type: "conversation_changed" };

export type ConversationScrollTransition = {
  state: ConversationScrollState;
  should_scroll_to_latest: boolean;
};

export type ConversationScrollFrameSchedulerOptions = {
  request_frame: (callback: () => void) => number;
  cancel_frame: (frameId: number) => void;
  get_conversation_generation: () => number;
  should_scroll: () => boolean;
  scroll_to_latest: (behavior: ScrollBehavior) => void;
};

export type ConversationScrollFrameScheduler = {
  request_scroll: (behavior?: ScrollBehavior) => void;
  cancel_scroll: () => void;
};

export const initialConversationScrollState: ConversationScrollState = {
  is_following_latest: true,
};

export function conversationEndDistance(
  metrics: ConversationScrollMetrics,
): number {
  return Math.max(
    0,
    metrics.scroll_height - metrics.client_height - metrics.scroll_top,
  );
}

export function isConversationNearEnd(
  metrics: ConversationScrollMetrics,
  thresholdPx = CONVERSATION_END_THRESHOLD_PX,
): boolean {
  return conversationEndDistance(metrics) <= Math.max(0, thresholdPx);
}

export function shouldShowJumpToLatest(
  state: ConversationScrollState,
): boolean {
  return !state.is_following_latest;
}

export function transitionConversationScroll(
  state: ConversationScrollState,
  event: ConversationScrollEvent,
): ConversationScrollTransition {
  switch (event.type) {
    case "viewport_scrolled":
      return {
        state: withFollowState(
          state,
          isConversationNearEnd(event.metrics),
        ),
        should_scroll_to_latest: false,
      };
    case "timeline_changed":
      return {
        state,
        should_scroll_to_latest: state.is_following_latest,
      };
    case "layout_change_requested":
      return {
        state: withFollowState(state, false),
        should_scroll_to_latest: false,
      };
    case "jump_requested":
    case "conversation_changed":
      return {
        state: withFollowState(state, true),
        should_scroll_to_latest: true,
      };
  }
}

export function createConversationScrollFrameScheduler({
  request_frame,
  cancel_frame,
  get_conversation_generation,
  should_scroll,
  scroll_to_latest,
}: ConversationScrollFrameSchedulerOptions): ConversationScrollFrameScheduler {
  let frameId: number | null = null;
  let requestedBehavior: ScrollBehavior = "auto";

  return {
    request_scroll(behavior = "auto") {
      if (frameId !== null) {
        if (behavior === "smooth") requestedBehavior = "smooth";
        return;
      }
      requestedBehavior = behavior;
      const conversationGeneration = get_conversation_generation();
      frameId = request_frame(() => {
        frameId = null;
        const behaviorForFrame = requestedBehavior;
        requestedBehavior = "auto";
        if (
          conversationGeneration !== get_conversation_generation() ||
          !should_scroll()
        ) {
          return;
        }
        scroll_to_latest(behaviorForFrame);
      });
    },
    cancel_scroll() {
      if (frameId !== null) {
        cancel_frame(frameId);
        frameId = null;
      }
      requestedBehavior = "auto";
    },
  };
}

function withFollowState(
  state: ConversationScrollState,
  isFollowingLatest: boolean,
): ConversationScrollState {
  return state.is_following_latest === isFollowingLatest
    ? state
    : { is_following_latest: isFollowingLatest };
}
