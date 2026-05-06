import { describe, expect, test } from "bun:test";
import { Renderer } from "./Renderer";

describe("Renderer.markerColorFor", () => {
  test("partial wins over error", () => {
    expect(Renderer.markerColorFor(true, true)).toBe("warning");
  });
  test("error when not partial", () => {
    expect(Renderer.markerColorFor(false, true)).toBe("error");
  });
  test("success otherwise", () => {
    expect(Renderer.markerColorFor(false, false)).toBe("success");
  });
});

describe("Renderer.buildPreviewLines", () => {
  test("returns body unchanged when within limit", () => {
    expect(Renderer.buildPreviewLines("a\nb\nc", 5)).toEqual({
      preview: "a\nb\nc",
      overflow: 0,
    });
  });
  test("truncates and reports overflow", () => {
    const body = "1\n2\n3\n4\n5\n6\n7";
    expect(Renderer.buildPreviewLines(body, 3)).toEqual({
      preview: "1\n2\n3",
      overflow: 4,
    });
  });
  test("limit equal to line count is not truncated", () => {
    expect(Renderer.buildPreviewLines("a\nb\nc", 3)).toEqual({
      preview: "a\nb\nc",
      overflow: 0,
    });
  });
});
