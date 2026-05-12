import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Renderer } from "./Renderer";

const stubTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

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

describe("Renderer.renderToolCallTitle", () => {
  test("leaves single-line titles unbordered", () => {
    const component = Renderer.renderToolCallTitle({
      label: "Bash",
      title: "pwd",
      theme: stubTheme,
      context: {
        lastComponent: undefined,
        isPartial: false,
        isError: false,
      },
    });

    expect(component.render(80)).toEqual([" ▪ Bash: pwd".padEnd(80, " ")]);
  });

  test("adds a left border to wrapped title lines", () => {
    const width = 18;
    const component = Renderer.renderToolCallTitle({
      label: "Bash",
      title: "one two three four five six seven",
      theme: stubTheme,
      context: {
        lastComponent: undefined,
        isPartial: false,
        isError: false,
      },
    });
    const lines = component.render(width);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => line.startsWith(" │ "))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
