import assert from "node:assert/strict";
import test from "node:test";
import {
  isModalNavigationOpen,
  modalFocusTrapTarget,
  MOBILE_NAVIGATION_QUERY,
} from "../src/navigation-state.ts";

test("mobile navigation covers portrait and short coarse-pointer landscapes", () => {
  assert.match(MOBILE_NAVIGATION_QUERY, /max-width: 768px/u);
  assert.match(MOBILE_NAVIGATION_QUERY, /max-height: 500px/u);
  assert.match(MOBILE_NAVIGATION_QUERY, /pointer: coarse/u);
});

test("navigation is modal only while open in the mobile viewport", () => {
  assert.equal(isModalNavigationOpen(false, true), false);
  assert.equal(isModalNavigationOpen(true, true), true);
  assert.equal(isModalNavigationOpen(true, false), false);
});

test("navigation focus wraps at both edges and recovers from outside focus", () => {
  assert.equal(
    modalFocusTrapTarget({
      isFocusInside: true,
      isFocusFirst: false,
      isFocusLast: true,
      shiftKey: false,
    }),
    "first",
  );
  assert.equal(
    modalFocusTrapTarget({
      isFocusInside: true,
      isFocusFirst: true,
      isFocusLast: false,
      shiftKey: true,
    }),
    "last",
  );
  assert.equal(
    modalFocusTrapTarget({
      isFocusInside: false,
      isFocusFirst: false,
      isFocusLast: false,
      shiftKey: false,
    }),
    "first",
  );
  assert.equal(
    modalFocusTrapTarget({
      isFocusInside: false,
      isFocusFirst: false,
      isFocusLast: false,
      shiftKey: true,
    }),
    "last",
  );
  assert.equal(
    modalFocusTrapTarget({
      isFocusInside: true,
      isFocusFirst: false,
      isFocusLast: false,
      shiftKey: false,
    }),
    null,
  );
});
