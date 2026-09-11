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

  test("matches `/` at the start of a line and after whitespace", () => {
    expect(at("/ski|")).toMatchObject({ kind: "command", query: "ski" });
    expect(at("say /ski|")).toMatchObject({ kind: "command", query: "ski" });
    expect(at("hi\n/ski|")).toMatchObject({ kind: "command", query: "ski" });
  });

  test("does not match a `/` glued to a word, as in a path", () => {
    expect(at("src/pick|")).toBeUndefined();
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

  test("a command mid-line replaces only its own sigil and query", () => {
    const text = "now /ski please";
    const token = activeToken(text, 8)!;

    expect(
      applyCompletion(text, 8, token, {
        value: "/skill:review",
        label: "/skill:review",
      })
    ).toEqual({
      text: "now /skill:review please",
      caret: 17,
      keepOpen: false,
    });
  });
});
