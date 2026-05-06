import { describe, expect, test } from "bun:test";
import { formatTitlePath } from "./render";

describe("formatTitlePath", () => {
  const cwd = "/work/repo";

  test("renders relative path with format only when no range", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: undefined,
        end: undefined,
        format: "hashline",
      })
    ).toBe("src/foo.ts (hashline)");
  });

  test("renders explicit start-end range", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: 40,
        end: 80,
        format: "hashline",
      })
    ).toBe("src/foo.ts:40-80 (hashline)");
  });

  test("renders start-only range", () => {
    expect(
      formatTitlePath({
        path: "/work/repo/src/foo.ts",
        cwd,
        start: 40,
        end: undefined,
        format: "plain",
      })
    ).toBe("src/foo.ts:40 (plain)");
  });

  test("falls back to absolute path when outside cwd", () => {
    expect(
      formatTitlePath({
        path: "/etc/hosts",
        cwd,
        start: undefined,
        end: undefined,
        format: "hashline",
      })
    ).toBe("/etc/hosts (hashline)");
  });

  test("placeholder when path is missing", () => {
    expect(
      formatTitlePath({
        path: undefined,
        cwd,
        start: undefined,
        end: undefined,
        format: "hashline",
      })
    ).toBe("... (hashline)");
  });
});
