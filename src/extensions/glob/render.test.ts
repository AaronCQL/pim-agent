import { describe, expect, test } from "bun:test";
import type { GlobMatch } from "./glob";
import { formatTitle, renderFiles } from "./render";

const fixture: readonly GlobMatch[] = [
  { path: "/repo/newer.ts", mtime: 2_000 },
  { path: "/repo/older.ts", mtime: 1_000 },
];

const relativeOptions = {
  cwd: "/repo",
  pathFormat: "relative",
} as const;

const absoluteOptions = {
  cwd: "/repo",
  pathFormat: "absolute",
} as const;

describe("renderFiles", () => {
  test("joins paths with newlines, newest first, relative by default", () => {
    const outcome = renderFiles(fixture, 1000, relativeOptions);
    expect(outcome.body).toBe("newer.ts\nolder.ts");
    expect(outcome.totalItems).toBe(2);
    expect(outcome.visibleItems).toBe(2);
    expect(outcome.truncated).toBe(false);
  });

  test("can render absolute paths", () => {
    const outcome = renderFiles(fixture, 1000, absoluteOptions);
    expect(outcome.body).toBe("/repo/newer.ts\n/repo/older.ts");
  });

  test("flips truncated when results exceed headLimit", () => {
    const outcome = renderFiles(fixture, 1, relativeOptions);
    expect(outcome.body).toBe("newer.ts");
    expect(outcome.truncated).toBe(true);
    expect(outcome.visibleItems).toBe(1);
    expect(outcome.totalItems).toBe(2);
  });

  test("returns a no-match outcome when there are no results", () => {
    const outcome = renderFiles([], 1000, relativeOptions);
    expect(outcome.body).toBe("No matches.");
    expect(outcome.truncated).toBe(false);
    expect(outcome.totalItems).toBe(0);
    expect(outcome.visibleItems).toBe(0);
  });
});

describe("formatTitle", () => {
  test("uses relative path under cwd", () => {
    const title = formatTitle({
      pattern: "**/*.ts",
      path: "/repo/src",
      cwd: "/repo",
    });
    expect(title).toBe("**/*.ts in src");
  });

  test("omits location when path is undefined", () => {
    const title = formatTitle({
      pattern: "**/*.ts",
      path: undefined,
      cwd: "/repo",
    });
    expect(title).toBe("**/*.ts");
  });

  test("omits location when path resolves to cwd", () => {
    const title = formatTitle({
      pattern: "**/*.ts",
      path: ".",
      cwd: "/repo",
    });
    expect(title).toBe("**/*.ts");
  });

  test("omits location when path is the absolute cwd", () => {
    const title = formatTitle({
      pattern: "**/*.ts",
      path: "/repo",
      cwd: "/repo",
    });
    expect(title).toBe("**/*.ts");
  });

  test("uses '...' placeholder when pattern is undefined", () => {
    const title = formatTitle({
      pattern: undefined,
      path: undefined,
      cwd: "/repo",
    });
    expect(title).toBe("...");
  });

  test("appends pluralized file count when provided", () => {
    const title = formatTitle({
      pattern: "**/*.ts",
      path: "/repo/src",
      cwd: "/repo",
      fileCount: 3,
    });
    expect(title).toBe("**/*.ts in src (3 files)");
  });

  test("uses singular noun for a single file", () => {
    const title = formatTitle({
      pattern: "**/*.ts",
      path: undefined,
      cwd: "/repo",
      fileCount: 1,
    });
    expect(title).toBe("**/*.ts (1 file)");
  });

  test("shows zero count without omitting the suffix", () => {
    const title = formatTitle({
      pattern: "**/*.ts",
      path: undefined,
      cwd: "/repo",
      fileCount: 0,
    });
    expect(title).toBe("**/*.ts (0 files)");
  });
});
