import { describe, expect, test } from "bun:test";

import { activeToken, applyCompletion, tokenKey } from "./token";

function at(text: string): ReturnType<typeof activeToken> {
  return activeToken(text.replace("|", ""), text.indexOf("|"));
}

describe("activeToken", () => {
  test("matches `@` at the start of the line and after whitespace", () => {
    expect(at("@src/a|")).toMatchObject({ kind: "file", query: "src/a" });
    expect(at("look at @src/a|")).toMatchObject({
      kind: "file",
      query: "src/a",
    });
    expect(at("look at @src/a| more")).toMatchObject({ query: "src/a" });
  });

  test("does not match an `@` glued to a word, as in an email", () => {
    expect(at("me@example|")).toBeUndefined();
  });

  test("matches `/` only at the start of a line", () => {
    expect(at("/ski|")).toMatchObject({ kind: "command", query: "ski" });
    expect(at("say /ski|")).toBeUndefined();
    expect(at("hi\n/ski|")).toMatchObject({ kind: "command", query: "ski" });
  });

  test("stops matching once the token has whitespace after it", () => {
    expect(at("@src/a |")).toBeUndefined();
    expect(at("/skill x|")).toBeUndefined();
  });

  test("the key changes only when the query moves", () => {
    expect(tokenKey(at("@src|"))).toBe(tokenKey(at("look @src|")));
    expect(tokenKey(at("@src|"))).not.toBe(tokenKey(at("@srx|")));
    expect(tokenKey(undefined)).toBe("");
  });
});

describe("applyCompletion", () => {
  test("replaces the sigil and the query, keeping what follows the caret", () => {
    const text = "look at @src/a rest";
    const token = activeToken(text, 14)!;

    expect(
      applyCompletion(text, 14, token, {
        value: "src/app.ts",
        label: "src/app.ts",
      })
    ).toEqual({ text: "look at @src/app.ts rest", caret: 19, keepOpen: false });
  });

  test("a directory keeps the picker open so the next segment can be drilled", () => {
    const text = "@src";
    const token = activeToken(text, 4)!;

    expect(
      applyCompletion(text, 4, token, { value: "src/", label: "src/" })
    ).toEqual({ text: "@src/", caret: 5, keepOpen: true });
  });

  test("a command completion lands with a trailing space", () => {
    const text = "/ski";
    const token = activeToken(text, 4)!;

    expect(
      applyCompletion(text, 4, token, {
        value: "/skill:review",
        label: "/skill:review",
      })
    ).toEqual({ text: "/skill:review ", caret: 14, keepOpen: false });
  });
});
