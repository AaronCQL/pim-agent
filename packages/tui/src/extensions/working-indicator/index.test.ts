import { describe, expect, test } from "bun:test";
import { formatElapsed } from "./index";

describe("working indicator formatting", () => {
  test("formats sub-minute elapsed time", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(32_000)).toBe("32s");
  });

  test("formats minute elapsed time", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(92_000)).toBe("1m 32s");
    expect(formatElapsed(3_599_000)).toBe("59m 59s");
  });

  test("formats hour elapsed time", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m 0s");
    expect(formatElapsed(3_692_000)).toBe("1h 1m 32s");
  });
});
