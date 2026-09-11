import { describe, expect, test } from "bun:test";

import { abbreviateHome, clockTime, elide, fit, relativeTime } from "./format";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const ago = (ms: number): string => relativeTime(NOW - ms, NOW);

describe("relativeTime", () => {
  test("picks the coarsest unit that still says something", () => {
    expect(ago(0)).toBe("0s");
    expect(ago(25_000)).toBe("25s");
    expect(ago(59_999)).toBe("59s");
    expect(ago(23 * 60_000)).toBe("23m");
    expect(ago(3 * 3_600_000)).toBe("3h");
    expect(ago(2 * 86_400_000)).toBe("2d");
    expect(ago(400 * 86_400_000)).toBe("400d");
  });

  test("a clock skewed into the future reads as now, not as negative", () => {
    expect(ago(-5000)).toBe("0s");
  });

  test("a session with no usable timestamp prints nothing", () => {
    expect(relativeTime(Number.NaN, NOW)).toBe("");
  });
});

describe("abbreviateHome", () => {
  test("collapses the two layouts a POSIX home has", () => {
    expect(abbreviateHome("/home/ada/dev/pim")).toBe("~/dev/pim");
    expect(abbreviateHome("/Users/ada")).toBe("~");
  });

  test("leaves anything it cannot recognise alone", () => {
    expect(abbreviateHome("/srv/app")).toBe("/srv/app");
    expect(abbreviateHome("/homely/place")).toBe("/homely/place");
    expect(abbreviateHome("C:\\Users\\ada")).toBe("C:\\Users\\ada");
  });
});

describe("clockTime", () => {
  test("prints the reader's own wall clock, 24-hour and zero-padded", () => {
    const at = new Date(2026, 0, 2, 7, 4, 30).getTime();
    expect(clockTime(at)).toBe("07:04");
  });

  test("a message with no usable stamp prints nothing", () => {
    expect(clockTime(0)).toBe("");
    expect(clockTime(Number.NaN)).toBe("");
  });
});

describe("elide", () => {
  test("both ends of a branch survive, and the middle pays", () => {
    expect(elide("chore/prerelease-cleanup", 20)).toBe("chore/prer…e-cleanup");
    expect(elide("very-long-project", 10)).toBe("very-…ject");
  });

  test("a prefix worth reading outlives the name it qualifies", () => {
    // The odd cell goes to the head, so `feat/` still reads as one where the
    // branch it names no longer does.
    expect(elide("feat/keyboard-shortcuts", 12)).toBe("feat/k…tcuts");
    expect(elide("feat/keyboard-shortcuts", 6)).toBe("fea…ts");
    expect(elide("feat/keyboard-shortcuts", 2)).toBe("f…");
  });

  test("leaves a text its budget already fits alone", () => {
    expect(elide("~/src/pim-agent", 15)).toBe("~/src/pim-agent");
    expect(elide("main", 40)).toBe("main");
  });

  test("spends exactly its budget, ellipsis included", () => {
    const text = "feat/a-long-branch-name";
    for (let columns = 1; columns <= text.length; columns++) {
      expect(elide(text, columns)).toHaveLength(columns);
    }
  });

  test("paints nothing with no room for even the ellipsis", () => {
    expect(elide("main", 0)).toBe("");
    expect(elide("main", -3)).toBe("");
    expect(elide("", 0)).toBe("");
  });
});

describe("fit", () => {
  const path = ["~/src/deep/pim-agent", "pim-agent"];

  test("takes the whole path where it fits, the directory alone where it does not", () => {
    expect(fit(path, 20)).toBe("~/src/deep/pim-agent");
    expect(fit(path, 19)).toBe("pim-agent");
    expect(fit(path, 9)).toBe("pim-agent");
  });

  test("cuts only what no choice of text can fit", () => {
    expect(fit(path, 8)).toBe("pim-…ent");
    expect(fit(["main"], 3)).toBe("m…n");
  });
});
