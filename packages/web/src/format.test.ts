import { describe, expect, test } from "bun:test";

import { abbreviateHome, clockTime, relativeTime } from "./format";

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
