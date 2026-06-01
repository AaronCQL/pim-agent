import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { formatTitlePath, renderTitlePath } from "./render";

function tracingTheme(): {
  readonly theme: Theme;
  readonly calls: { readonly color: ThemeColor; readonly text: string }[];
} {
  const calls: { color: ThemeColor; text: string }[] = [];
  return {
    calls,
    theme: {
      fg: (color: ThemeColor, text: string) => {
        calls.push({ color, text });
        return `<${color}>${text}</${color}>`;
      },
    } as unknown as Theme,
  };
}

describe("formatTitlePath", () => {
  const cwd = "/work/repo";

  test("renders relative path without format suffix", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
      })
    ).toBe("src/foo.ts");
  });

  test("renders explicit start-end range", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: 40,
        end: 80,
      })
    ).toBe("src/foo.ts:40-80");
  });

  test("renders start-only range", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: 40,
        end: undefined,
      })
    ).toBe("src/foo.ts:40");
  });

  test("falls back to absolute path when outside cwd", () => {
    expect(
      formatTitlePath({
        path: "/etc/hosts",
        cwd,
        start: undefined,
        end: undefined,
      })
    ).toBe("/etc/hosts");
  });

  test("placeholder when path is missing", () => {
    expect(
      formatTitlePath({
        path: undefined,
        cwd,
        start: undefined,
        end: undefined,
      })
    ).toBe("...");
  });

  test("uses the visible range after execution even when no range was requested", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
        outcome: { visibleStart: 1, visibleEnd: 7 },
      })
    ).toBe("src/foo.ts:1-7");
  });

  test("uses the actual visible end instead of an overlarge requested end", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: 1,
        end: 999,
        outcome: { visibleStart: 1, visibleEnd: 7 },
      })
    ).toBe("src/foo.ts:1-7");
  });

  test("renders only the line range suffix with the muted theme color", () => {
    const themed = tracingTheme();
    const title = renderTitlePath(
      {
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
        outcome: { visibleStart: 1, visibleEnd: 7 },
      },
      themed.theme
    );

    expect(title).toBe("src/foo.ts<muted>:1-7</muted>");
    expect(themed.calls).toEqual([{ color: "muted", text: ":1-7" }]);
  });
});
