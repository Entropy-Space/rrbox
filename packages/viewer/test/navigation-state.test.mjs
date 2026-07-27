import assert from "node:assert/strict";
import test from "node:test";
import {
  isModalNavigationOpen,
  navigationFocusTrapTarget,
} from "../src/navigation-state.ts";

test("navigation is modal only while open in the mobile viewport", () => {
  assert.equal(isModalNavigationOpen(false, true), false);
  assert.equal(isModalNavigationOpen(true, true), true);
  assert.equal(isModalNavigationOpen(true, false), false);
});

test("navigation focus wraps at both edges and recovers from outside focus", () => {
  assert.equal(
    navigationFocusTrapTarget({
      isFocusInside: true,
      isFocusFirst: false,
      isFocusLast: true,
      shiftKey: false,
    }),
    "first",
  );
  assert.equal(
    navigationFocusTrapTarget({
      isFocusInside: true,
      isFocusFirst: true,
      isFocusLast: false,
      shiftKey: true,
    }),
    "last",
  );
  assert.equal(
    navigationFocusTrapTarget({
      isFocusInside: false,
      isFocusFirst: false,
      isFocusLast: false,
      shiftKey: false,
    }),
    "first",
  );
  assert.equal(
    navigationFocusTrapTarget({
      isFocusInside: false,
      isFocusFirst: false,
      isFocusLast: false,
      shiftKey: true,
    }),
    "last",
  );
  assert.equal(
    navigationFocusTrapTarget({
      isFocusInside: true,
      isFocusFirst: false,
      isFocusLast: false,
      shiftKey: false,
    }),
    null,
  );
});
