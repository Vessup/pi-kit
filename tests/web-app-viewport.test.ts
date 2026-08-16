import assert from "node:assert/strict";
import test from "node:test";
import { resolveAppViewportRect } from "../web/client/app-viewport.ts";

test("standalone non-keyboard states do not pin to the visual viewport", () => {
  assert.equal(resolveAppViewportRect({
    standalone: true,
    innerHeight: 956,
    screenHeight: 956,
    visualHeight: 956,
    visualOffsetTop: 0,
  }), undefined);
  assert.equal(resolveAppViewportRect({
    standalone: true,
    innerHeight: 956,
    screenHeight: 956,
    visualHeight: 920,
    visualOffsetTop: 0,
  }), undefined);
});

test("standalone viewport pins to the scrolled visual rect while the keyboard is open", () => {
  assert.deepEqual(resolveAppViewportRect({
    standalone: true,
    innerHeight: 543,
    screenHeight: 956,
    visualHeight: 543,
    visualOffsetTop: 351,
  }), { top: 351, height: 543 });
});

test("ordinary browsers and pinch zoom follow the visual rect", () => {
  assert.equal(resolveAppViewportRect({ standalone: false, innerHeight: 800, screenHeight: 956 }), undefined);
  assert.deepEqual(resolveAppViewportRect({
    standalone: true,
    innerHeight: 956,
    screenHeight: 956,
    visualHeight: 600,
    visualOffsetTop: 20,
    visualScale: 1.5,
  }), { top: 20, height: 600 });
});
