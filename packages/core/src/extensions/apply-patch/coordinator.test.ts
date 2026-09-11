import { describe, expect, test } from "bun:test";
import { computeActiveTools } from "./coordinator";

const AVAILABLE = ["read", "edit", "apply_patch", "bash"] as const;

describe("computeActiveTools", () => {
  test("gpt swaps edit -> apply_patch, preserving order and others", () => {
    expect(
      computeActiveTools(AVAILABLE, ["read", "edit", "bash"], true)
    ).toEqual(["read", "apply_patch", "bash"]);
  });

  test("non-gpt swaps apply_patch -> edit", () => {
    expect(
      computeActiveTools(AVAILABLE, ["read", "apply_patch", "bash"], false)
    ).toEqual(["read", "edit", "bash"]);
  });

  test("no-op when neither tool is active (user opt-out)", () => {
    const active = ["read", "bash"];
    expect(computeActiveTools(AVAILABLE, active, true)).toBe(active);
  });

  test("forces edit when apply_patch is unavailable", () => {
    const active = ["read", "edit", "bash"];
    expect(computeActiveTools(["read", "edit", "bash"], active, true)).toBe(
      active
    );
    expect(
      computeActiveTools(
        ["read", "edit", "bash"],
        ["read", "apply_patch", "bash"],
        true
      )
    ).toEqual(["read", "edit", "bash"]);
  });

  test("forces apply_patch when edit is unavailable", () => {
    const active = ["read", "apply_patch", "bash"];
    expect(
      computeActiveTools(["read", "apply_patch", "bash"], active, false)
    ).toBe(active);
    expect(
      computeActiveTools(
        ["read", "apply_patch", "bash"],
        ["read", "edit", "bash"],
        false
      )
    ).toEqual(["read", "apply_patch", "bash"]);
  });

  test("adds the only available edit tool when neither is active", () => {
    expect(
      computeActiveTools(["read", "edit"], ["read", "bash"], true)
    ).toEqual(["read", "bash", "edit"]);
  });

  test("adds the only available apply_patch tool when neither is active", () => {
    expect(
      computeActiveTools(["read", "apply_patch"], ["read", "bash"], false)
    ).toEqual(["read", "bash", "apply_patch"]);
  });

  test("returns same reference when already correct (gpt)", () => {
    const active = ["read", "apply_patch", "bash"];
    expect(computeActiveTools(AVAILABLE, active, true)).toBe(active);
  });

  test("returns same reference when already correct (non-gpt)", () => {
    const active = ["read", "edit", "bash"];
    expect(computeActiveTools(AVAILABLE, active, false)).toBe(active);
  });

  test("collapses both slots into one when both are active", () => {
    expect(
      computeActiveTools(AVAILABLE, ["edit", "apply_patch"], true)
    ).toEqual(["apply_patch"]);
    expect(
      computeActiveTools(AVAILABLE, ["edit", "apply_patch"], false)
    ).toEqual(["edit"]);
  });

  test("is idempotent", () => {
    const once = computeActiveTools(AVAILABLE, ["read", "edit"], true);
    const twice = computeActiveTools(AVAILABLE, [...once], true);
    expect(twice).toEqual(["read", "apply_patch"]);
  });
});
