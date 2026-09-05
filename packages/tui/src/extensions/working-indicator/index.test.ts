import { describe, expect, test } from "bun:test";
import { Format } from "#core/shared/Format";

describe("working indicator formatting", () => {
  test("formats sub-minute elapsed time", () => {
    expect(Format.formatElapsed(0)).toBe("0s");
    expect(Format.formatElapsed(999)).toBe("0s");
    expect(Format.formatElapsed(32_000)).toBe("32s");
  });

  test("formats minute elapsed time", () => {
    expect(Format.formatElapsed(60_000)).toBe("1m 0s");
    expect(Format.formatElapsed(92_000)).toBe("1m 32s");
    expect(Format.formatElapsed(3_599_000)).toBe("59m 59s");
  });

  test("formats hour elapsed time", () => {
    expect(Format.formatElapsed(3_600_000)).toBe("1h 0m 0s");
    expect(Format.formatElapsed(3_692_000)).toBe("1h 1m 32s");
  });
});
