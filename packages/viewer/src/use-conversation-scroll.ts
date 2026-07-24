import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import {
  createConversationScrollFrameScheduler,
  initialConversationScrollState,
  isConversationNearEnd,
  shouldShowJumpToLatest,
  transitionConversationScroll,
  type ConversationScrollEvent,
  type ConversationScrollFrameScheduler,
} from "./conversation-scroll.ts";

type UseConversationScrollOptions = {
  activeProjectId: string | null;
  activeSessionId: string | null;
  timeline: readonly unknown[];
};

type ConversationScrollController = {
  messageListRef: RefObject<HTMLDivElement | null>;
  conversationContentRef: RefObject<HTMLDivElement | null>;
  conversationEndRef: RefObject<HTMLDivElement | null>;
  showJumpToLatest: boolean;
  handleConversationScroll: () => void;
  handleConversationKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  handleConversationClickCapture: (
    event: MouseEvent<HTMLDivElement>,
  ) => void;
  handleJumpToLatest: (event: MouseEvent<HTMLButtonElement>) => void;
  interruptJumpToLatest: () => void;
};

const CONVERSATION_SCROLL_KEYS = new Set([
  " ",
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  "Spacebar",
]);

export function useConversationScroll({
  activeProjectId,
  activeSessionId,
  timeline,
}: UseConversationScrollOptions): ConversationScrollController {
  const hasConversation = timeline.length > 0;
  const [scrollState, setScrollState] = useState(
    initialConversationScrollState,
  );
  const scrollStateRef = useRef(initialConversationScrollState);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const conversationContentRef = useRef<HTMLDivElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const conversationGenerationRef = useRef(0);
  const isJumpingToLatestRef = useRef(false);
  const focusMessageListAfterScrollRef = useRef(false);
  const activeConversationRef = useRef({
    project_id: activeProjectId,
    session_id: activeSessionId,
  });
  const scrollSchedulerRef =
    useRef<ConversationScrollFrameScheduler | null>(null);

  const getScrollScheduler = useCallback(() => {
    if (scrollSchedulerRef.current !== null) {
      return scrollSchedulerRef.current;
    }
    const scheduler = createConversationScrollFrameScheduler({
      request_frame: (callback) => requestAnimationFrame(callback),
      cancel_frame: (frameId) => cancelAnimationFrame(frameId),
      get_conversation_generation: () =>
        conversationGenerationRef.current,
      should_scroll: () => scrollStateRef.current.is_following_latest,
      scroll_to_latest: (behavior) => {
        conversationEndRef.current?.scrollIntoView({
          behavior,
          block: "end",
        });
        if (focusMessageListAfterScrollRef.current) {
          focusMessageListAfterScrollRef.current = false;
          messageListRef.current?.focus({ preventScroll: true });
        }
      },
    });
    scrollSchedulerRef.current = scheduler;
    return scheduler;
  }, []);

  const transitionScrollState = useCallback(
    (event: ConversationScrollEvent) => {
      const transition = transitionConversationScroll(
        scrollStateRef.current,
        event,
      );
      scrollStateRef.current = transition.state;
      setScrollState(transition.state);
      return transition;
    },
    [],
  );

  const cancelScheduledScroll = useCallback(() => {
    scrollSchedulerRef.current?.cancel_scroll();
    focusMessageListAfterScrollRef.current = false;
  }, []);

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      getScrollScheduler().request_scroll(behavior);
    },
    [getScrollScheduler],
  );

  useEffect(() => {
    const activeConversation = activeConversationRef.current;
    const conversationChanged =
      activeConversation.project_id !== activeProjectId ||
      activeConversation.session_id !== activeSessionId;
    if (conversationChanged) {
      conversationGenerationRef.current += 1;
      cancelScheduledScroll();
    }
    activeConversationRef.current = {
      project_id: activeProjectId,
      session_id: activeSessionId,
    };
    const transition = transitionScrollState({
      type: conversationChanged
        ? "conversation_changed"
        : "timeline_changed",
    });
    if (!transition.should_scroll_to_latest) return;
    if (conversationChanged) {
      isJumpingToLatestRef.current = false;
    }
    scrollToLatest();
  }, [
    activeProjectId,
    activeSessionId,
    cancelScheduledScroll,
    scrollToLatest,
    timeline,
    transitionScrollState,
  ]);

  useEffect(
    () => cancelScheduledScroll,
    [cancelScheduledScroll],
  );

  const readScrollMetrics = useCallback(() => {
    const messageList = messageListRef.current;
    if (!messageList) return null;
    return {
      scroll_top: messageList.scrollTop,
      scroll_height: messageList.scrollHeight,
      client_height: messageList.clientHeight,
    };
  }, []);

  useEffect(() => {
    if (!hasConversation) return;
    const remeasure = () => {
      const metrics = readScrollMetrics();
      if (!metrics) return;
      if (scrollStateRef.current.is_following_latest) {
        scrollToLatest();
        return;
      }
      transitionScrollState({
        type: "viewport_scrolled",
        metrics,
      });
    };
    const messageList = messageListRef.current;
    const conversationContent = conversationContentRef.current;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", remeasure);
      return () => window.removeEventListener("resize", remeasure);
    }
    const resizeObserver = new ResizeObserver(remeasure);
    if (messageList) resizeObserver.observe(messageList);
    if (conversationContent) resizeObserver.observe(conversationContent);
    return () => resizeObserver.disconnect();
  }, [
    hasConversation,
    readScrollMetrics,
    scrollToLatest,
    transitionScrollState,
  ]);

  const handleConversationScroll = useCallback(() => {
    const metrics = readScrollMetrics();
    if (!metrics) return;
    if (isJumpingToLatestRef.current) {
      if (isConversationNearEnd(metrics)) {
        isJumpingToLatestRef.current = false;
      }
      return;
    }
    const transition = transitionScrollState({
      type: "viewport_scrolled",
      metrics,
    });
    if (!transition.state.is_following_latest) {
      cancelScheduledScroll();
    }
  }, [
    cancelScheduledScroll,
    readScrollMetrics,
    transitionScrollState,
  ]);

  const interruptJumpToLatest = useCallback(() => {
    isJumpingToLatestRef.current = false;
    cancelScheduledScroll();
  }, [cancelScheduledScroll]);

  const handleConversationKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (CONVERSATION_SCROLL_KEYS.has(event.key)) {
        interruptJumpToLatest();
      }
    },
    [interruptJumpToLatest],
  );

  const handleConversationClickCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("summary") === null
      ) {
        return;
      }
      isJumpingToLatestRef.current = false;
      cancelScheduledScroll();
      transitionScrollState({
        type: "layout_change_requested",
      });
    },
    [cancelScheduledScroll, transitionScrollState],
  );

  const handleJumpToLatest = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const transition = transitionScrollState({
        type: "jump_requested",
      });
      if (!transition.should_scroll_to_latest) return;
      isJumpingToLatestRef.current = true;
      focusMessageListAfterScrollRef.current = event.detail === 0;
      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      scrollToLatest(prefersReducedMotion ? "auto" : "smooth");
    },
    [scrollToLatest, transitionScrollState],
  );

  return {
    messageListRef,
    conversationContentRef,
    conversationEndRef,
    showJumpToLatest:
      hasConversation && shouldShowJumpToLatest(scrollState),
    handleConversationScroll,
    handleConversationKeyDown,
    handleConversationClickCapture,
    handleJumpToLatest,
    interruptJumpToLatest,
  };
}
