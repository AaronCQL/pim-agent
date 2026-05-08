import { describe, expect, test } from "bun:test";
import { formatTitlePath } from "./render";

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
});
