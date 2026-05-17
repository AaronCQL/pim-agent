import { describe, expect, test } from "bun:test";
import { Type, type TSchema } from "typebox";
import { StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import { Tools } from "./Tools";

function runValidator(parameters: TSchema, args: unknown): Error {
  try {
    validateToolArguments({ name: "t", parameters } as never, {
      type: "toolCall",
      id: "1",
      name: "t",
      arguments: args as Record<string, unknown>,
    });
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected validation to fail");
}

function rewrite(toolName: string, parameters: TSchema, args: unknown): string {
  return Tools.rewriteValidationError(
    toolName,
    parameters as never,
    runValidator(parameters, args),
    args
  );
}

describe("Tools.rewriteValidationError", () => {
  test("missing single required property at root", () => {
    const params = Type.Object({ path: Type.String() });
    expect(rewrite("read", params, {})).toBe(
      'Validation failed for tool "read":\n  - missing required property: path'
    );
  });

  test("missing multiple required properties at root", () => {
    const params = Type.Object({
      path: Type.String(),
      edits: Type.Array(Type.String()),
    });
    expect(rewrite("edit", params, {})).toBe(
      'Validation failed for tool "edit":\n  - missing required properties: path, edits'
    );
  });

  test("missing nested required property", () => {
    const params = Type.Object({
      path: Type.String(),
      edits: Type.Array(
        Type.Object({
          old_string: Type.String(),
          new_string: Type.String(),
        })
      ),
    });
    expect(
      rewrite("edit", params, { path: "foo", edits: [{ old_string: "x" }] })
    ).toBe(
      'Validation failed for tool "edit":\n  - missing required property at edits.0: new_string'
    );
  });

  test("constraint messages pass through with original path", () => {
    const params = Type.Object({
      limit: Type.Integer({ minimum: 1, maximum: 2000 }),
    });
    expect(rewrite("read", params, { limit: 99999 })).toBe(
      'Validation failed for tool "read":\n  - limit: must be <= 2000'
    );
  });

  test("strips Received arguments dump", () => {
    const params = Type.Object({ path: Type.String() });
    expect(rewrite("read", params, {})).not.toContain("Received arguments");
  });

  test("non-validation errors pass through unchanged", () => {
    expect(
      Tools.rewriteValidationError(
        "read",
        Type.Object({}) as never,
        new Error("boom")
      )
    ).toBe("boom");
  });

  test("union of literals collapses to enumerated values (bare strings, no quotes)", () => {
    const params = Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("delete"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("update_prompt"),
      ]),
    });
    expect(rewrite("task", params, { action: "foo" })).toBe(
      'Validation failed for tool "task":\n  - action: must be one of: create, list, delete, pause, resume, update_prompt'
    );
  });

  test("tagged union collapses to discriminator values (bare strings)", () => {
    const params = Type.Object({
      schedule: Type.Union([
        Type.Object({ type: Type.Literal("once"), at: Type.String() }),
        Type.Object({ type: Type.Literal("interval"), every: Type.String() }),
        Type.Object({ type: Type.Literal("cron"), expr: Type.String() }),
      ]),
    });
    expect(
      rewrite("task", params, { schedule: { type: "foo", at: "x" } })
    ).toBe(
      'Validation failed for tool "task":\n  - schedule: must match one of the allowed variants (type: once, interval, cron)'
    );
  });

  test("tagged union with discriminator match shows only matched branch errors", () => {
    const params = Type.Object({
      schedule: Type.Union([
        Type.Object({ type: Type.Literal("once"), at: Type.String() }),
        Type.Object({ type: Type.Literal("interval"), every: Type.String() }),
        Type.Object({ type: Type.Literal("cron"), expr: Type.String() }),
      ]),
    });
    expect(rewrite("task", params, { schedule: { type: "once" } })).toBe(
      'Validation failed for tool "task":\n  - missing required property at schedule: at'
    );
  });

  test("StringEnum lists valid values (bare strings)", () => {
    const params = Type.Object({
      outputMode: StringEnum(["files_with_matches", "content", "count"]),
    });
    expect(rewrite("grep", params, { outputMode: "invalid_enum_value" })).toBe(
      'Validation failed for tool "grep":\n  - outputMode: must be one of: files_with_matches, content, count'
    );
  });
});

describe("Tools.wrap quoted-enum coercion", () => {
  function wrapTool(params: TSchema) {
    return Tools.wrap({
      name: "task",
      label: "task",
      description: "test",
      parameters: params,
      async execute() {
        return { content: [{ type: "text", text: "" }], details: {} };
      },
    });
  }

  test("unwraps double-quoted enum value", () => {
    const wrapped = wrapTool(
      Type.Object({
        action: Type.Union([Type.Literal("create"), Type.Literal("list")]),
      })
    );
    expect(wrapped.prepareArguments!({ action: '"create"' })).toEqual({
      action: "create",
    });
  });

  test("unwraps single-quoted enum value", () => {
    const wrapped = wrapTool(Type.Object({ mode: StringEnum(["foo", "bar"]) }));
    expect(wrapped.prepareArguments!({ mode: "'bar'" })).toEqual({
      mode: "bar",
    });
  });

  test("unwraps backtick-quoted enum value", () => {
    const wrapped = wrapTool(Type.Object({ mode: StringEnum(["foo", "bar"]) }));
    expect(wrapped.prepareArguments!({ mode: "`foo`" })).toEqual({
      mode: "foo",
    });
  });

  test("does NOT unwrap when inner value is invalid (still errors)", () => {
    const wrapped = wrapTool(
      Type.Object({
        action: Type.Union([Type.Literal("create"), Type.Literal("list")]),
      })
    );
    expect(() => wrapped.prepareArguments!({ action: '"nope"' })).toThrow(
      'Validation failed for tool "task":\n  - action: must be one of: create, list'
    );
  });

  test("unwraps nested enum inside tagged union branch", () => {
    const wrapped = wrapTool(
      Type.Object({
        schedule: Type.Union([
          Type.Object({ type: Type.Literal("once"), at: Type.String() }),
          Type.Object({
            type: Type.Literal("interval"),
            every: Type.String(),
          }),
        ]),
      })
    );
    expect(
      wrapped.prepareArguments!({
        schedule: { type: '"once"', at: "2026-01-01T00:00:00Z" },
      })
    ).toEqual({
      schedule: { type: "once", at: "2026-01-01T00:00:00Z" },
    });
  });

  test("leaves non-enum string fields alone", () => {
    const wrapped = wrapTool(
      Type.Object({ prompt: Type.String(), action: StringEnum(["a"]) })
    );
    expect(
      wrapped.prepareArguments!({ prompt: '"hello"', action: "a" })
    ).toEqual({ prompt: '"hello"', action: "a" });
  });
});

describe("Tools.wrap unknown property detection", () => {
  test("rejects unknown top-level key", () => {
    const params = Type.Object({ command: Type.String() });
    const wrapped = Tools.wrap({
      name: "bash",
      label: "bash",
      description: "test",
      parameters: params,
      async execute() {
        return { content: [{ type: "text", text: "" }], details: {} };
      },
    });
    expect(() =>
      wrapped.prepareArguments!({ command: "ls", fakeParam: "x" })
    ).toThrow(
      'Validation failed for tool "bash":\n  - unknown property: fakeParam'
    );
  });

  test("suggests close matches by edit distance", () => {
    const params = Type.Object({ headLimit: Type.Integer() });
    const wrapped = Tools.wrap({
      name: "grep",
      label: "grep",
      description: "test",
      parameters: params,
      async execute() {
        return { content: [{ type: "text", text: "" }], details: {} };
      },
    });
    expect(() =>
      wrapped.prepareArguments!({ headLimit: 1, headlimit: 1 })
    ).toThrow(
      'Validation failed for tool "grep":\n  - unknown property: headlimit (did you mean "headLimit"?)'
    );
  });
});

describe("Tools.wrap", () => {
  test("prepareArguments rewrites the thrown message", () => {
    const params = Type.Object({ path: Type.String() });
    const wrapped = Tools.wrap({
      name: "read",
      label: "read",
      description: "test",
      parameters: params,
      async execute() {
        return { content: [{ type: "text", text: "" }], details: {} };
      },
    });
    expect(() => wrapped.prepareArguments!({})).toThrow(
      'Validation failed for tool "read":\n  - missing required property: path'
    );
  });

  test("prepareArguments returns coerced args on success", () => {
    const params = Type.Object({ count: Type.Integer() });
    const wrapped = Tools.wrap({
      name: "t",
      label: "t",
      description: "test",
      parameters: params,
      async execute() {
        return { content: [{ type: "text", text: "" }], details: {} };
      },
    });
    expect(wrapped.prepareArguments!({ count: "42" })).toEqual({ count: 42 });
  });
});

describe("Tools.register", () => {
  test("forwards the wrapped def to pi.registerTool", () => {
    const params = Type.Object({ path: Type.String() });
    let captured: ReturnType<typeof Tools.wrap> | undefined;
    const fakePi = {
      registerTool(def: ReturnType<typeof Tools.wrap>) {
        captured = def;
      },
    };
    Tools.register(fakePi as never, {
      name: "read",
      label: "read",
      description: "test",
      parameters: params,
      async execute() {
        return { content: [{ type: "text", text: "" }], details: {} };
      },
    });
    expect(captured?.prepareArguments).toBeDefined();
    expect(() => captured!.prepareArguments!({})).toThrow(
      'Validation failed for tool "read":\n  - missing required property: path'
    );
  });
});
