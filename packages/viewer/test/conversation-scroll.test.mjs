import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_END_THRESHOLD_PX,
  conversationEndDistance,
  createConversationScrollFrameScheduler,
  initialConversationScrollState,
  isConversationNearEnd,
  shouldShowJumpToLatest,
  transitionConversationScroll,
} from "../src/conversation-scroll.ts";

test("conversation end distance is clamped at the bottom", () => {
  assert.equal(
    conversationEndDistance(metrics({
      scroll_height: 400,
      client_height: 500,
    })),
    0,
  );
  assert.equal(
    conversationEndDistance(metrics({
      scroll_top: 550,
      scroll_height: 1_000,
      client_height: 500,
    })),
    0,
  );
  assert.equal(
    conversationEndDistance(metrics({
      scroll_top: 300,
      scroll_height: 1_000,
      client_height: 500,
    })),
    200,
  );
});

test("the follow threshold is inclusive and configurable", () => {
  assert.equal(
    isConversationNearEnd(metrics({
      scroll_top:
        500 - CONVERSATION_END_THRESHOLD_PX,
    })),
    true,
  );
  assert.equal(
    isConversationNearEnd(metrics({
      scroll_top:
        500 - CONVERSATION_END_THRESHOLD_PX - 1,
    })),
    false,
  );
  assert.equal(
    isConversationNearEnd(metrics({ scroll_top: 490 }), 10),
    true,
  );
  assert.equal(
    isConversationNearEnd(metrics({ scroll_top: 489 }), 10),
    false,
  );
  assert.equal(
    isConversationNearEnd(metrics({ scroll_top: 499 }), -1),
    false,
  );
});

test("manual scrolling pauses following until the viewport returns near the end", () => {
  const paused = transitionConversationScroll(
    initialConversationScrollState,
    {
      type: "viewport_scrolled",
      metrics: metrics({ scroll_top: 300 }),
    },
  );

  assert.deepEqual(paused, {
    state: { is_following_latest: false },
    should_scroll_to_latest: false,
  });
  assert.equal(shouldShowJumpToLatest(paused.state), true);

  const resumed = transitionConversationScroll(paused.state, {
    type: "viewport_scrolled",
    metrics: metrics({ scroll_top: 500 }),
  });
  assert.deepEqual(resumed, {
    state: { is_following_latest: true },
    should_scroll_to_latest: false,
  });
  assert.equal(shouldShowJumpToLatest(resumed.state), false);
});

test("timeline changes scroll only while following latest", () => {
  const following = transitionConversationScroll(
    initialConversationScrollState,
    { type: "timeline_changed" },
  );
  assert.equal(following.should_scroll_to_latest, true);

  const pausedState = { is_following_latest: false };
  const paused = transitionConversationScroll(pausedState, {
    type: "timeline_changed",
  });
  assert.equal(paused.state, pausedState);
  assert.equal(paused.should_scroll_to_latest, false);
});

test("deliberate layout changes pause following until remeasurement", () => {
  const requested = transitionConversationScroll(
    initialConversationScrollState,
    { type: "layout_change_requested" },
  );
  assert.deepEqual(requested, {
    state: { is_following_latest: false },
    should_scroll_to_latest: false,
  });

  const timelineChanged = transitionConversationScroll(requested.state, {
    type: "timeline_changed",
  });
  assert.equal(timelineChanged.should_scroll_to_latest, false);

  const remeasured = transitionConversationScroll(requested.state, {
    type: "viewport_scrolled",
    metrics: metrics({ scroll_top: 500 }),
  });
  assert.equal(remeasured.state.is_following_latest, true);
});

test("jumping and changing conversations resume following with one scroll request", () => {
  const pausedState = { is_following_latest: false };

  for (const type of ["jump_requested", "conversation_changed"]) {
    const transition = transitionConversationScroll(pausedState, {
      type,
    });
    assert.deepEqual(transition, {
      state: { is_following_latest: true },
      should_scroll_to_latest: true,
    });
    assert.equal(shouldShowJumpToLatest(transition.state), false);
  }
});

test("animation frames are coalesced without starving fast stream updates", () => {
  const frameHost = createFrameHost();
  const scrolls = [];
  const scheduler = createConversationScrollFrameScheduler({
    request_frame: frameHost.requestFrame,
    cancel_frame: frameHost.cancelFrame,
    get_conversation_generation: () => 7,
    should_scroll: () => true,
    scroll_to_latest: (behavior) => scrolls.push(behavior),
  });

  scheduler.request_scroll();
  scheduler.request_scroll();
  scheduler.request_scroll("smooth");

  assert.equal(frameHost.pendingCount(), 1);
  frameHost.runNext();
  assert.deepEqual(scrolls, ["smooth"]);
  assert.equal(frameHost.pendingCount(), 0);

  scheduler.request_scroll();
  assert.equal(frameHost.pendingCount(), 1);
  frameHost.runNext();
  assert.deepEqual(scrolls, ["smooth", "auto"]);
});

test("stale, paused, and canceled animation frames cannot move the viewport", () => {
  const frameHost = createFrameHost();
  const scrolls = [];
  let conversationGeneration = 1;
  let shouldScroll = true;
  const scheduler = createConversationScrollFrameScheduler({
    request_frame: frameHost.requestFrame,
    cancel_frame: frameHost.cancelFrame,
    get_conversation_generation: () => conversationGeneration,
    should_scroll: () => shouldScroll,
    scroll_to_latest: (behavior) => scrolls.push(behavior),
  });

  scheduler.request_scroll();
  shouldScroll = false;
  frameHost.runNext();
  assert.deepEqual(scrolls, []);

  shouldScroll = true;
  scheduler.request_scroll();
  conversationGeneration += 1;
  frameHost.runNext();
  assert.deepEqual(scrolls, []);

  scheduler.request_scroll();
  scheduler.cancel_scroll();
  assert.equal(frameHost.pendingCount(), 0);
  frameHost.runNext();
  assert.deepEqual(scrolls, []);
});

function metrics(overrides = {}) {
  return {
    scroll_top: 500,
    scroll_height: 1_000,
    client_height: 500,
    ...overrides,
  };
}

function createFrameHost() {
  let nextFrameId = 1;
  const callbacks = new Map();

  return {
    requestFrame(callback) {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    },
    cancelFrame(frameId) {
      callbacks.delete(frameId);
    },
    pendingCount() {
      return callbacks.size;
    },
    runNext() {
      const next = callbacks.entries().next();
      if (next.done) return;
      const [frameId, callback] = next.value;
      callbacks.delete(frameId);
      callback();
    },
  };
}
