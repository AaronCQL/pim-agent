import "../test/dom";

import { afterEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { mountPoint } from "../test/dom";
import { drag } from "../test/touch";
import { createSwipe, type SwipeDirection } from "./swipe";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

function swipeable(toward: SwipeDirection): {
  readonly host: HTMLElement;
  readonly swiped: () => number;
} {
  const host = mountPoint();
  let count = 0;
  createRoot((dispose) => {
    disposers.push(dispose);
    createSwipe(toward, () => {
      count += 1;
    })(host);
  });
  return { host, swiped: () => count };
}

function child(host: HTMLElement, tag = "div"): HTMLElement {
  const element = document.createElement(tag);
  host.append(element);
  return element;
}

test("a horizontal swipe fires once, in its own direction only", () => {
  const { host, swiped } = swipeable("right");
  drag(host, { x: 10, y: 100 }, { x: 200, y: 110 });
  expect(swiped()).toBe(1);

  drag(host, { x: 200, y: 100 }, { x: 10, y: 100 });
  expect(swiped()).toBe(1);

  const left = swipeable("left");
  drag(left.host, { x: 200, y: 100 }, { x: 10, y: 100 });
  expect(left.swiped()).toBe(1);
});

test("a scroll or a short drag is not a swipe", () => {
  const { host, swiped } = swipeable("right");
  drag(host, { x: 10, y: 100 }, { x: 60, y: 300 });
  drag(host, { x: 10, y: 100 }, { x: 40, y: 100 });
  expect(swiped()).toBe(0);
});

test("content that can scroll back the swipe's way keeps the touch", () => {
  const { host, swiped } = swipeable("right");
  const code = child(host);
  code.style.overflowX = "auto";
  const line = child(code, "span");

  Object.defineProperty(code, "scrollLeft", { value: 40, configurable: true });
  drag(line, { x: 10, y: 100 }, { x: 200, y: 100 });
  expect(swiped()).toBe(0);

  Object.defineProperty(code, "scrollLeft", { value: 0, configurable: true });
  drag(line, { x: 10, y: 100 }, { x: 200, y: 100 });
  expect(swiped()).toBe(1);
});

test("a dialog stacked inside the host keeps the touch, the host's own does not", () => {
  const { host, swiped } = swipeable("right");
  const inner = child(child(host, "dialog"));
  drag(inner, { x: 10, y: 100 }, { x: 200, y: 100 });
  expect(swiped()).toBe(0);

  const dialog = document.createElement("dialog");
  mountPoint().append(dialog);
  createRoot((dispose) => {
    disposers.push(dispose);
    createSwipe("left", () => {
      dialog.dataset.swiped = "yes";
    })(dialog);
  });
  drag(child(dialog), { x: 200, y: 100 }, { x: 10, y: 100 });
  expect(dialog.dataset.swiped).toBe("yes");
});

test("a disposed swipe stops listening", () => {
  const { host, swiped } = swipeable("right");
  disposers.pop()?.();
  drag(host, { x: 10, y: 100 }, { x: 200, y: 100 });
  expect(swiped()).toBe(0);
});
