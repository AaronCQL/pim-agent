import { describe, expect, test } from "bun:test";

import { FileTitle } from "./FileTitle";

function fit(path: string, columns: number, oldPath?: string): string {
  return FileTitle.text(
    FileTitle.fit(FileTitle.readings(path, oldPath), columns)
  );
}

/**
 * A file list is read by the names in it, and a monorepo spends the head of
 * every path saying the same thing. So the room a narrow bar is short goes out
 * of the directories, from the far end, and the name survives whole.
 */
describe("a path too wide for its bar", () => {
  const path = "packages/web/src/topbar/BranchMenu.test.tsx";

  test("is whole when it fits", () => {
    expect(fit(path, 60)).toBe(path);
  });

  test("drops leading directories, nearest last", () => {
    expect(fit(path, 40)).toBe("…/web/src/topbar/BranchMenu.test.tsx");
    expect(fit(path, 30)).toBe("…/topbar/BranchMenu.test.tsx");
    expect(fit(path, 25)).toBe("…/BranchMenu.test.tsx");
  });

  test("keeps the name alone rather than lose a character of it", () => {
    expect(fit(path, 20)).toBe("BranchMenu.test.tsx");
  });

  /**
   * Two rows of the same file are told apart by the end of the name as often
   * as the start — `BranchMenu.tsx` against `BranchMenu.test.tsx` — so the last
   * resort spends the middle.
   */
  test("elides a name wider than the whole bar middle-out", () => {
    expect(fit(path, 12)).toBe("Branch…t.tsx");
  });

  test("lights the name and leads with the directories", () => {
    expect(FileTitle.fit(FileTitle.readings(path, undefined), 30)).toEqual([
      { text: "…/topbar/", role: "lead" },
      { text: "BranchMenu.test.tsx", role: "name" },
    ]);
  });

  test("leaves a file at the root of the repo alone", () => {
    expect(fit("AGENTS.md", 20)).toBe("AGENTS.md");
  });
});

describe("a move too wide for its bar", () => {
  const path = "packages/web/src/diff/DiffView.tsx";
  const old = "packages/web/src/diff/DiffOverlay.tsx";

  test("reads as one braced path while it fits", () => {
    expect(fit(path, 60, old)).toBe(
      "packages/web/src/diff/{DiffOverlay.tsx ➝ DiffView.tsx}"
    );
  });

  test("spends the shared directories before either name", () => {
    expect(fit(path, 40, old)).toBe("…/diff/{DiffOverlay.tsx ➝ DiffView.tsx}");
  });

  /** The row's own `R` says it moved; the path it came from is one tap away. */
  test("falls back to the path it arrived at", () => {
    expect(fit(path, 24, old)).toBe("…/src/diff/DiffView.tsx");
  });

  test("folds a directory move around the name that did not change", () => {
    expect(
      fit(
        "packages/daemon/src/TelegramSurface.ts",
        60,
        "packages/telegram/src/TelegramSurface.ts"
      )
    ).toBe("packages/{telegram ➝ daemon}/src/TelegramSurface.ts");
  });
});
