import { describe, expect, test } from "bun:test";
import { computeActiveTools } from "./coordinator";

describe("computeActiveTools", () => {
  test("gpt swaps edit -> apply_patch, preserving order and others", () => {
    expect(computeActiveTools(["read", "edit", "bash"], true)).toEqual([
      "read",
      "apply_patch",
      "bash",
    ]);
  });

  test("non-gpt swaps apply_patch -> edit", () => {
    expect(computeActiveTools(["read", "apply_patch", "bash"], false)).toEqual([
      "read",
      "edit",
      "bash",
    ]);
  });

  test("no-op when neither tool is active (user opt-out)", () => {
    const active = ["read", "bash"];
    expect(computeActiveTools(active, true)).toBe(active);
  });

  test("returns same reference when already correct (gpt)", () => {
    const active = ["read", "apply_patch", "bash"];
    expect(computeActiveTools(active, true)).toBe(active);
  });

  test("returns same reference when already correct (non-gpt)", () => {
    const active = ["read", "edit", "bash"];
    expect(computeActiveTools(active, false)).toBe(active);
  });

  test("collapses both slots into one when both are active", () => {
    expect(computeActiveTools(["edit", "apply_patch"], true)).toEqual([
      "apply_patch",
    ]);
    expect(computeActiveTools(["edit", "apply_patch"], false)).toEqual([
      "edit",
    ]);
  });

  test("is idempotent", () => {
    const once = computeActiveTools(["read", "edit"], true);
    const twice = computeActiveTools([...once], true);
    expect(twice).toEqual(["read", "apply_patch"]);
  });
});
