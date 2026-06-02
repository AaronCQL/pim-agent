import { describe, expect, test } from "bun:test";
import { Tools } from "../../shared/Tools";
import { applyPatchSchema, prepareApplyPatchArguments } from "./schema";

describe("prepareApplyPatchArguments", () => {
  test("canonical {input} passes through", () => {
    expect(prepareApplyPatchArguments({ input: "x" })).toEqual({ input: "x" });
  });

  test("bare string -> {input}", () => {
    expect(prepareApplyPatchArguments("x")).toEqual({ input: "x" });
  });

  test("{patch} alias -> {input}, dropping the alias key", () => {
    expect(prepareApplyPatchArguments({ patch: "x" })).toEqual({ input: "x" });
  });

  test("{patchText} alias -> {input}", () => {
    expect(prepareApplyPatchArguments({ patchText: "x" })).toEqual({
      input: "x",
    });
  });

  test("{patch_text} alias -> {input}", () => {
    expect(prepareApplyPatchArguments({ patch_text: "x" })).toEqual({
      input: "x",
    });
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

  test("accepts an alias and normalizes to {input}", () => {
    expect(wrapped.prepareArguments?.({ patch: "x" })).toEqual({ input: "x" });
  });

  test("rejects an unknown key alongside a valid input", () => {
    expect(() =>
      wrapped.prepareArguments?.({ input: "x", bogus: "y" })
    ).toThrow(/unknown property: bogus/);
  });

  test("rejects an unrecognized-only key (no input)", () => {
    expect(() => wrapped.prepareArguments?.({ inpit: "x" })).toThrow(
      /Validation failed/
    );
  });
});
