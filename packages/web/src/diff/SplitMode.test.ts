import "../test/dom";

import { expect, test } from "bun:test";

import { SplitMode } from "./SplitMode";

/**
 * The width is the pane's, not the window's: a diff beside a sidebar has less
 * of the screen than the media query the switch used to ask would have said.
 */

test("auto takes the split as soon as the pane can seat it", () => {
  expect(SplitMode.split("auto", 900)).toBe(true);
  expect(SplitMode.split("auto", 899)).toBe(false);
  expect(SplitMode.split("auto", 0)).toBe(false);
});

test("a chosen layout is the layout, at any width", () => {
  expect(SplitMode.split("split", 200)).toBe(true);
  expect(SplitMode.split("unified", 4000)).toBe(false);
});

test("a preference read back as anything else is no preference", () => {
  expect(SplitMode.parse("split")).toBe("split");
  expect(SplitMode.parse("side-by-side")).toBe("auto");
  expect(SplitMode.parse(undefined)).toBe("auto");
});
