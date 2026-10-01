import { describe, expect, test } from "bun:test";
import { Tools } from "../../shared/Tools";
import { applyPatchSchema, prepareApplyPatchArguments } from "./schema";

describe("prepareApplyPatchArguments", () => {
  test.each([
    { input: "x" },
    "x",
    { patch: "x" },
    { patchText: "x" },
    { patch_text: "x" },
  ])("normalizes %j to {input}", (raw) => {
    expect(prepareApplyPatchArguments(raw)).toEqual({ input: "x" });
  });
});

describe("Tools.wrap with apply_patch schema", () => {
  const wrapped = Tools.wrap({
    name: "apply_patch",
    label: "Edit",
    description: "",
    parameters: applyPatchSchema,
    prepareArguments: prepareApplyPatchArguments,
    renderShell: "self",
    executionMode: "sequential",
    async execute() {
      return { content: [], details: {} };
    },
  });

  test("accepts an alias", () => {
    expect(wrapped.prepareArguments?.({ patch: "x" })).toEqual({ input: "x" });
  });

  test("rejects an unknown key alongside a valid input", () => {
    expect(() =>
      wrapped.prepareArguments?.({ input: "x", bogus: "y" })
    ).toThrow(/unknown property: bogus/);
  });
});
