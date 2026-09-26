import { afterEach, describe, expect, test } from "bun:test";
import { totalmem } from "node:os";
import { MEMORY_LIMIT_VAR, MemoryCap } from "./MemoryCap";

const previous = process.env[MEMORY_LIMIT_VAR];

afterEach(() => {
  if (previous === undefined) {
    delete process.env[MEMORY_LIMIT_VAR];
  } else {
    process.env[MEMORY_LIMIT_VAR] = previous;
  }
});

function limitFor(value: string | undefined): number | null {
  if (value === undefined) {
    delete process.env[MEMORY_LIMIT_VAR];
  } else {
    process.env[MEMORY_LIMIT_VAR] = value;
  }
  return MemoryCap.limitBytes();
}

describe("MemoryCap.limitBytes", () => {
  test("defaults to a quarter of RAM", () => {
    expect(limitFor(undefined)).toBe(Math.floor(totalmem() / 4));
  });

  test("reads sizes the way systemd writes them", () => {
    expect(limitFor("8G")).toBe(8 * 1024 ** 3);
    expect(limitFor("512M")).toBe(512 * 1024 ** 2);
    expect(limitFor("1.5GiB")).toBe(1.5 * 1024 ** 3);
    expect(limitFor("4096")).toBe(4096);
  });

  test("off, infinity and 0 lift the limit", () => {
    for (const value of ["off", "infinity", "0"]) {
      expect(limitFor(value)).toBeNull();
    }
  });

  test("a value that is not a size names the variable", () => {
    expect(() => limitFor("lots")).toThrow(MEMORY_LIMIT_VAR);
  });
});
