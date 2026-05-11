import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterLine } from "./segments";

function stripAnsi(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 27 && s[i + 1] === "[") {
      i += 2;
      while (i < s.length && s[i] !== "m") {
        i++;
      }
    } else {
      out += s[i]!;
    }
  }
  return out;
}

function createCtx(
  branch: readonly unknown[] = [],
  options: {
    readonly cwd?: string;
    readonly model?: { readonly id: string; readonly reasoning?: boolean };
  } = {}
): ExtensionContext {
  return {
    sessionManager: {
      getCwd: () => options.cwd ?? "/home/aaroncql/dev/pim-agent",
      getBranch: () => branch,
    },
    getContextUsage: () => ({
      tokens: 200_000,
      contextWindow: 200_000,
      percent: 50,
    }),
    model: options.model ?? {
      id: "gpt-5.5",
      reasoning: true,
    },
  } as unknown as ExtensionContext;
}

describe("renderFooterLine", () => {
  test("does not exceed narrow terminal widths", () => {
    const ctx = createCtx();
    const widths = [0, 1, 2, 3, 4, 8, 10, 12, 16, 20, 40];

    for (const width of widths) {
      const line = renderFooterLine(
        width,
        ctx,
        {
          branch: "feat/some-very-long-branch",
          dirty: true,
          ahead: 12,
          behind: 3,
        },
        12.34
      );

      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("drops lower-priority segments as width tightens", () => {
    const ctx = createCtx(
      [{ type: "thinking_level_change", thinkingLevel: "medium" }],
      { cwd: "/x/proj" }
    );
    const git = {
      branch: "main",
      dirty: true,
      ahead: 2,
      behind: 0,
    };

    expect(stripAnsi(renderFooterLine(200, ctx, git, 1.23))).toContain(
      "gpt-5.5"
    );
    expect(stripAnsi(renderFooterLine(200, ctx, git, 1.23))).toContain("$1.23");
    expect(stripAnsi(renderFooterLine(200, ctx, git, 1.23))).toContain("main");
    expect(stripAnsi(renderFooterLine(200, ctx, git, 1.23))).toContain(
      "50%/200K"
    );

    const withoutModel = stripAnsi(renderFooterLine(50, ctx, git, 1.23));
    expect(withoutModel).not.toContain("gpt-5.5");
    expect(withoutModel).toContain("$1.23");
    expect(withoutModel).toContain("main");
    expect(withoutModel).toContain("50%/200K");

    const withoutCost = stripAnsi(renderFooterLine(40, ctx, git, 1.23));
    expect(withoutCost).not.toContain("$1.23");
    expect(withoutCost).toContain("main");
    expect(withoutCost).toContain("50%/200K");

    const withoutGit = stripAnsi(renderFooterLine(35, ctx, git, 1.23));
    expect(withoutGit).not.toContain("main");
    expect(withoutGit).toContain("/x/proj");
    expect(withoutGit).toContain("50%/200K");

    const cwdOnly = stripAnsi(renderFooterLine(20, ctx, git, 1.23));
    expect(cwdOnly).toContain("/x/proj");
    expect(cwdOnly).not.toContain("50%/200K");
  });

  test("renders latest reasoning level for reasoning models", () => {
    const medium = stripAnsi(
      renderFooterLine(
        120,
        createCtx([{ type: "thinking_level_change", thinkingLevel: "medium" }]),
        { branch: null, dirty: false, ahead: 0, behind: 0 },
        0
      )
    );
    expect(medium).toContain("gpt-5.5");
    expect(medium).toContain("med");

    const latestWins = stripAnsi(
      renderFooterLine(
        120,
        createCtx([
          { type: "thinking_level_change", thinkingLevel: "minimal" },
          { type: "thinking_level_change", thinkingLevel: "xhigh" },
        ]),
        { branch: null, dirty: false, ahead: 0, behind: 0 },
        0
      )
    );
    expect(latestWins).toContain("xhigh");
    expect(latestWins).not.toContain("min");

    const noLevel = stripAnsi(
      renderFooterLine(
        120,
        createCtx(),
        { branch: null, dirty: false, ahead: 0, behind: 0 },
        0
      )
    );
    expect(noLevel).toContain("off");
  });

  test("omits reasoning level for non-reasoning models", () => {
    const line = stripAnsi(
      renderFooterLine(
        120,
        createCtx(
          [{ type: "thinking_level_change", thinkingLevel: "medium" }],
          {
            model: { id: "gpt-5.5" },
          }
        ),
        { branch: null, dirty: false, ahead: 0, behind: 0 },
        0
      )
    );

    expect(line).toContain("gpt-5.5");
    expect(line).not.toContain("med");
  });
});
