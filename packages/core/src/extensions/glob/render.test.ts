import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { AnsiPainter } from "../../view/AnsiPainter";
import type { GlobMatch } from "./glob";
import { globView, renderFiles } from "./render";
import type { GlobDetails, GlobInput } from "./schema";

const fixture: readonly GlobMatch[] = [
  { path: "/repo/newer.ts", mtime: 2_000 },
  { path: "/repo/older.ts", mtime: 1_000 },
];

const relativeOptions = {
  cwd: "/repo",
  isPartial: false,
  pathFormat: "relative",
} as const;

const absoluteOptions = {
  cwd: "/repo",
  isPartial: false,
  pathFormat: "absolute",
} as const;

const stubTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function result(
  body: string,
  details: Partial<GlobDetails> = {}
): AgentToolResult<GlobDetails> {
  return {
    content: [{ type: "text", text: body }],
    details: {
      absolutePath: "/repo",
      pattern: "**/*.ts",
      exclude: undefined,
      includeDotfiles: false,
      includeIgnored: false,
      pathFormat: "relative",
      fileCount: 2,
      totalItems: 2,
      visibleItems: 2,
      truncated: false,
      ...details,
    },
  };
}

function title(
  args: Partial<GlobInput>,
  settled?: AgentToolResult<GlobDetails>
): string {
  const view = globView({
    args: args as GlobInput,
    result: settled,
    cwd: "/repo",
    isPartial: false,
  });
  return AnsiPainter.paint(view.title, stubTheme).join(" ");
}

function body(settled: AgentToolResult<GlobDetails>): string[] {
  const view = globView({
    args: { pattern: "**/*.ts" },
    result: settled,
    cwd: "/repo",
    isPartial: false,
  });
  return AnsiPainter.paint(view.body ?? [], stubTheme);
}

describe("globView", () => {
  test("supplies the title-cased display label", () => {
    expect(
      globView({
        args: { pattern: "**/*.ts" } as GlobInput,
        cwd: "/repo",
        isPartial: false,
      }).label
    ).toBe("Glob");
  });
});

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

describe("globView title", () => {
  test("uses relative path under cwd", () => {
    expect(title({ pattern: "**/*.ts", path: "/repo/src" })).toBe(
      "**/*.ts in src"
    );
  });

  test("omits location when path is undefined", () => {
    expect(title({ pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  test("omits location when path resolves to cwd", () => {
    expect(title({ pattern: "**/*.ts", path: "." })).toBe("**/*.ts");
  });

  test("omits location when path is the absolute cwd", () => {
    expect(title({ pattern: "**/*.ts", path: "/repo" })).toBe("**/*.ts");
  });

  test("uses '...' placeholder while the pattern is still streaming", () => {
    expect(title({})).toBe("...");
  });

  test("appends pluralized file count once the call settles", () => {
    expect(
      title(
        { pattern: "**/*.ts", path: "/repo/src" },
        result("src/a.ts", { fileCount: 3 })
      )
    ).toBe("**/*.ts in src 3 files");
  });

  test("uses singular noun for a single file", () => {
    expect(
      title({ pattern: "**/*.ts" }, result("a.ts", { fileCount: 1 }))
    ).toBe("**/*.ts 1 file");
  });

  test("shows zero count without omitting the suffix", () => {
    expect(
      title({ pattern: "**/*.ts" }, result("No matches.", { fileCount: 0 }))
    ).toBe("**/*.ts 0 files");
  });
});

describe("globView body", () => {
  test("paints one line per matched path", () => {
    expect(body(result("src/a.ts\nsrc/b.ts"))).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("keeps the no-match message as plain text", () => {
    expect(body(result("No matches.", { fileCount: 0 }))).toEqual([
      "No matches.",
    ]);
  });

  test("is empty when the result carries no text", () => {
    expect(body(result(""))).toEqual([]);
  });
});
