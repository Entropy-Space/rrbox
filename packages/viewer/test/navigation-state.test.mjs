import assert from "node:assert/strict";
import test from "node:test";
import { isModalNavigationOpen } from "../src/navigation-state.ts";

test("navigation is modal only while open in the mobile viewport", () => {
  assert.equal(isModalNavigationOpen(false, true), false);
  assert.equal(isModalNavigationOpen(true, true), true);
  assert.equal(isModalNavigationOpen(true, false), false);
});
