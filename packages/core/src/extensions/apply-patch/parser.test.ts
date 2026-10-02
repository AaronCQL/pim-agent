import { describe, expect, test } from "bun:test";
import { parsePatch } from "./parser";

const wrap = (body: string): string =>
  `*** Begin Patch\n${body}\n*** End Patch`;

describe("parsePatch", () => {
  test("parses an Add File hunk", () => {
    const patch = parsePatch(wrap("*** Add File: foo.txt\n+hello\n+world"));
    expect(patch.hunks).toEqual([
      { kind: "add", path: "foo.txt", contents: "hello\nworld\n" },
    ]);
  });

  test("parses a Delete File hunk", () => {
    const patch = parsePatch(wrap("*** Delete File: gone.txt"));
    expect(patch.hunks).toEqual([{ kind: "delete", path: "gone.txt" }]);
  });

  test("parses an Update File hunk with @@ anchor", () => {
    const patch = parsePatch(
      wrap("*** Update File: a.py\n@@ def f():\n-    pass\n+    return 1")
    );
    expect(patch.hunks).toEqual([
      {
        kind: "update",
        path: "a.py",
        movePath: undefined,
        chunks: [
          {
            changeContext: "def f():",
            oldLines: ["    pass"],
            newLines: ["    return 1"],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  test("parses a pure rename (Move to with no hunks)", () => {
    const patch = parsePatch(wrap("*** Update File: a.py\n*** Move to: b.py"));
    expect(patch.hunks).toEqual([
      { kind: "update", path: "a.py", movePath: "b.py", chunks: [] },
    ]);
  });

  test("parses multiple chunks in one Update hunk", () => {
    const patch = parsePatch(
      wrap("*** Update File: a.py\n@@ foo\n-bar\n+BAR\n@@ baz\n-qux\n+QUX")
    );
    const hunk = patch.hunks[0];
    if (hunk?.kind !== "update") {
      throw new Error("expected update");
    }
    expect(hunk.chunks).toHaveLength(2);
    expect(hunk.chunks[0]?.changeContext).toBe("foo");
    expect(hunk.chunks[1]?.changeContext).toBe("baz");
  });

  test("parses *** End of File marker", () => {
    const patch = parsePatch(
      wrap("*** Update File: a.py\n@@\n+line\n*** End of File")
    );
    const hunk = patch.hunks[0];
    if (hunk?.kind !== "update") {
      throw new Error("expected update");
    }
    expect(hunk.chunks[0]?.isEndOfFile).toBe(true);
  });

  test("allows missing @@ on first chunk", () => {
    const patch = parsePatch(wrap("*** Update File: a.py\n import foo\n+bar"));
    const hunk = patch.hunks[0];
    if (hunk?.kind !== "update") {
      throw new Error("expected update");
    }
    expect(hunk.chunks[0]).toEqual({
      changeContext: undefined,
      oldLines: ["import foo"],
      newLines: ["import foo", "bar"],
      isEndOfFile: false,
    });
  });

  test("parses several operations in one patch", () => {
    const patch = parsePatch(
      wrap(
        "*** Add File: add.py\n+abc\n*** Delete File: del.py\n*** Update File: up.py\n@@\n-old\n+new"
      )
    );
    expect(patch.hunks.map((h) => h.kind)).toEqual(["add", "delete", "update"]);
  });

  test("strips leading @ and quotes from paths", () => {
    const patch = parsePatch(wrap('*** Add File: @"foo bar.txt"\n+x'));
    expect(patch.hunks[0]).toMatchObject({ path: "foo bar.txt" });
  });

  test.each([
    ["bad\n*** End Patch", "Do not include Markdown fences"],
    [
      "*** Begin Patch\nbad",
      "Do not include Markdown fences or trailing prose after it",
    ],
    [wrap("*** Update File: a.py"), "Include @@ plus at least one context"],
    [wrap("*** Frobnicate File: a.py"), "Do not use unified-diff file headers"],
    [
      wrap("*** Add File: a.txt\nhello"),
      "Added file content lines must start with '+'",
    ],
    [
      wrap("*** Delete File: a.txt\n-unexpected"),
      "Delete File hunks must not contain content lines",
    ],
    [
      wrap("*** Update File: a.py\n*** Move to:"),
      "destination path is required",
    ],
    [
      wrap("*** Update File: a.py\n*** Move to: @"),
      "destination path is required",
    ],
    [
      wrap("*** Update File: a.py\n*** Move to:b.py"),
      "use '*** Move to: {path}'",
    ],
    [
      wrap("*** Update File: a.py\n*** Move: b.py"),
      "Use '*** Move to: {path}'",
    ],
    [
      wrap("*** Update File: a.py\n@@\nbad"),
      "Unchanged context lines must be prefixed with a single space",
    ],
    [
      wrap("*** Update File: a.py\n@@\n-a\n+b\nbad"),
      "Start each additional edit chunk with @@ or @@ followed by nearby context",
    ],
  ])("rejects %j", (text, message) => {
    expect(() => parsePatch(text)).toThrow(message);
  });
});
