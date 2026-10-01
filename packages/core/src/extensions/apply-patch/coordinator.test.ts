import { describe, expect, test } from "bun:test";
import { computeActiveTools } from "./coordinator";

const AVAILABLE = ["read", "edit", "apply_patch", "bash"] as const;

describe("computeActiveTools", () => {
  test.each([
    [
      AVAILABLE,
      ["read", "edit", "bash"],
      true,
      ["read", "apply_patch", "bash"],
    ],
    [
      AVAILABLE,
      ["read", "apply_patch", "bash"],
      false,
      ["read", "edit", "bash"],
    ],
    [
      ["read", "edit", "bash"],
      ["read", "apply_patch", "bash"],
      true,
      ["read", "edit", "bash"],
    ],
    [
      ["read", "apply_patch", "bash"],
      ["read", "edit", "bash"],
      false,
      ["read", "apply_patch", "bash"],
    ],
    [["read", "edit"], ["read", "bash"], true, ["read", "bash", "edit"]],
    [
      ["read", "apply_patch"],
      ["read", "bash"],
      false,
      ["read", "bash", "apply_patch"],
    ],
    [AVAILABLE, ["edit", "apply_patch"], true, ["apply_patch"]],
    [AVAILABLE, ["edit", "apply_patch"], false, ["edit"]],
  ] as const)(
    "%j, %j, prefer patch %p -> %j",
    (available, active, prefer, expected) => {
      expect(computeActiveTools(available, active, prefer)).toEqual(expected);
    }
  );

  test.each([
    [AVAILABLE, ["read", "bash"], true],
    [AVAILABLE, ["read", "apply_patch", "bash"], true],
    [AVAILABLE, ["read", "edit", "bash"], false],
    [["read", "edit", "bash"], ["read", "edit", "bash"], true],
    [["read", "apply_patch", "bash"], ["read", "apply_patch", "bash"], false],
  ] as const)(
    "keeps the same array for %j, %j, prefer patch %p",
    (available, active, prefer) => {
      expect(computeActiveTools(available, active, prefer)).toBe(active);
    }
  );
});
