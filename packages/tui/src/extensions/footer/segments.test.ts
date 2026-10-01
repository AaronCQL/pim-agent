import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { GitState } from "#core/shared/Git";
import { GIT_DIRTY_ICON } from "./powerline";
import { renderFooterLine } from "./segments";

const NO_GIT: GitState = {
  branch: null,
  dirtyCount: 0,
  ahead: 0,
  behind: 0,
  revision: "",
};

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
    model: options.model ?? { id: "gpt-5.5", reasoning: true },
  } as unknown as ExtensionContext;
}

function render(
  width: number,
  ctx: ExtensionContext,
  git: Partial<GitState> = {},
  cost = 0
): string {
  return Bun.stripANSI(
    renderFooterLine(width, ctx, { ...NO_GIT, ...git }, cost)
  );
}

function level(...levels: string[]): unknown[] {
  return levels.map((thinkingLevel) => ({
    type: "thinking_level_change",
    thinkingLevel,
  }));
}

describe("renderFooterLine", () => {
  test("does not exceed narrow terminal widths", () => {
    const ctx = createCtx();
    const git = {
      branch: "feat/some-very-long-branch",
      dirtyCount: 1,
      ahead: 12,
      behind: 3,
    };

    for (const width of [0, 1, 2, 3, 4, 8, 10, 12, 16, 20, 40]) {
      const line = renderFooterLine(width, ctx, { ...NO_GIT, ...git }, 12.34);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("drops lower-priority segments as width tightens", () => {
    const ctx = createCtx(level("medium"), { cwd: "/x/proj" });
    const git = { branch: "main", dirtyCount: 1, ahead: 2 };
    const at = (width: number) => render(width, ctx, git, 1.23);

    const full = at(200);
    for (const part of ["gpt-5.5", "$1.23", "main", "50.0%/200K"]) {
      expect(full).toContain(part);
    }

    const withoutModel = at(50);
    expect(withoutModel).not.toContain("gpt-5.5");
    expect(withoutModel).toContain("$1.23");
    expect(withoutModel).toContain("main");
    expect(withoutModel).toContain("50.0%/200K");

    const withoutCost = at(40);
    expect(withoutCost).not.toContain("$1.23");
    expect(withoutCost).toContain("main");
    expect(withoutCost).toContain("50.0%/200K");

    const withoutGit = at(35);
    expect(withoutGit).not.toContain("main");
    expect(withoutGit).toContain("/x/proj");
    expect(withoutGit).toContain("50.0%/200K");

    const cwdOnly = at(20);
    expect(cwdOnly).toContain("/x/proj");
    expect(cwdOnly).not.toContain("50.0%/200K");
  });

  test("renders latest reasoning level for reasoning models", () => {
    const medium = render(120, createCtx(level("medium")));
    expect(medium).toContain("gpt-5.5");
    expect(medium).toContain("med");

    const latestWins = render(120, createCtx(level("minimal", "xhigh")));
    expect(latestWins).toContain("xhigh");
    expect(latestWins).not.toContain("min");

    expect(render(120, createCtx())).toContain("off");
  });

  test("shows the dirty count only when the tree is dirty", () => {
    const dirty = render(120, createCtx(), { branch: "main", dirtyCount: 3 });
    expect(dirty).toContain(`${GIT_DIRTY_ICON}3`);

    const clean = render(120, createCtx(), { branch: "main" });
    expect(clean).toContain("main");
    expect(clean).not.toContain(GIT_DIRTY_ICON);
  });

  test("omits reasoning level for non-reasoning models", () => {
    const line = render(
      120,
      createCtx(level("medium"), { model: { id: "gpt-5.5" } })
    );

    expect(line).toContain("gpt-5.5");
    expect(line).not.toContain("med");
  });
});
