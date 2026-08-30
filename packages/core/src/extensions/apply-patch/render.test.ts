import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { DiffLines, type ToolDiff } from "../../shared/DiffLines";
import { AnsiPainter } from "../../view/AnsiPainter";
import type { ApplyEntry } from "./executor";
import { type ApplyPatchViewInput, applyPatchView } from "./render";

const theme = {
  name: "test",
  fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
  strikethrough: (text: string) => `<s>${text}</s>`,
} as unknown as Theme;

const added = (n: number) => `<toolDiffAdded>+${n}</toolDiffAdded>`;
const removed = (n: number) => `<toolDiffRemoved>-${n}</toolDiffRemoved>`;
const dim = (text: string) => `<dim>${text}</dim>`;
const titled = (text: string) => `<toolTitle>${text}</toolTitle>`;
const header = (label: string, title: string) =>
  `<success> ▪</success> <toolTitle>${label}</toolTitle><toolTitle>: ${title}</toolTitle>`;

const cwd = "/repo";

const changeDiff = (path: string): ToolDiff =>
  DiffLines.buildToolDiff(
    path,
    { lines: ["alpha", "beta"], hasTrailingNewline: true },
    { lines: ["alpha", "BETA"], hasTrailingNewline: true },
    3
  )!;

const addDiff = (path: string): ToolDiff =>
  DiffLines.buildToolDiff(
    path,
    { lines: [], hasTrailingNewline: false },
    { lines: ["one", "two"], hasTrailingNewline: true },
    3
  )!;

const removeDiff = (path: string): ToolDiff =>
  DiffLines.buildToolDiff(
    path,
    { lines: ["x", "y", "z"], hasTrailingNewline: true },
    { lines: [], hasTrailingNewline: false },
    3
  )!;

function view(
  entries: readonly ApplyEntry[] | undefined,
  args: ApplyPatchViewInput["args"] = { input: "" }
): ReturnType<typeof applyPatchView> {
  return applyPatchView({
    args,
    result:
      entries === undefined
        ? undefined
        : {
            content: [{ type: "text", text: "ok" }],
            details: { entries },
          },
    cwd,
    isPartial: false,
  });
}

function paintTitle(
  entries: readonly ApplyEntry[] | undefined,
  args?: ApplyPatchViewInput["args"]
): string {
  return AnsiPainter.paint(view(entries, args).title, theme).join(" ");
}

function paintBody(entries: readonly ApplyEntry[]): string {
  return AnsiPainter.paint(view(entries).body ?? [], theme).join("\n");
}

const patchText = "*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y";

describe("applyPatchView in flight", () => {
  test("titles the row from the first path in the raw patch text", () => {
    expect(paintTitle(undefined, { input: patchText })).toBe("a.txt");
    expect(view(undefined, { input: patchText }).label).toBe("Edit");
  });

  test("placeholder when the patch text has not streamed in yet", () => {
    expect(paintTitle(undefined, { input: "" })).toBe("...");
    expect(
      paintTitle(undefined, undefined as unknown as ApplyPatchViewInput["args"])
    ).toBe("...");
  });

  test("keeps the call title when the result carries no entries", () => {
    expect(paintTitle([], { input: patchText })).toBe("a.txt");
  });

  test("skips a no-op update that rewrote identical content", () => {
    expect(
      paintTitle(
        [{ action: { kind: "update", path: "/repo/a.txt" }, diff: undefined }],
        { input: patchText }
      )
    ).toBe("a.txt");
  });
});

describe("applyPatchView first entry", () => {
  test("update titles the row with the path and its stats", () => {
    const entries: ApplyEntry[] = [
      {
        action: { kind: "update", path: "/repo/a.txt" },
        diff: changeDiff("/repo/a.txt"),
      },
    ];
    expect(view(entries).label).toBe("Edit");
    expect(paintTitle(entries)).toBe(`a.txt ${added(1)}/${removed(1)}`);
    expect(paintBody(entries)).toContain("BETA");
  });

  test("add renders a Write label with the created content as the body", () => {
    const entries: ApplyEntry[] = [
      {
        action: { kind: "add", path: "/repo/new.ts" },
        diff: addDiff("/repo/new.ts"),
      },
    ];
    expect(view(entries).label).toBe("Write");
    expect(paintTitle(entries)).toBe(`new.ts ${added(2)}`);
    expect(paintBody(entries)).toContain("one");
    expect(paintBody(entries)).toContain("two");
  });

  test("delete renders a Delete label, title only with a -N stat", () => {
    const entries: ApplyEntry[] = [
      {
        action: { kind: "delete", path: "/repo/old.ts" },
        diff: removeDiff("/repo/old.ts"),
      },
    ];
    expect(view(entries).label).toBe("Delete");
    expect(paintTitle(entries)).toBe(`old.ts ${removed(3)}`);
    expect(paintBody(entries)).toBe("");
  });

  test("pure rename renders Move with a compact arrow title and no body", () => {
    const entries: ApplyEntry[] = [
      {
        action: {
          kind: "move",
          path: "/repo/.pim-edit-tool-test/beta.txt",
          movePath: "/repo/.pim-edit-tool-test/gamma.txt",
        },
        diff: undefined,
      },
    ];
    expect(view(entries).label).toBe("Move");
    expect(paintTitle(entries)).toBe(
      `.pim-edit-tool-test/${dim("{")}${dim("<s>beta.txt</s>")}${dim(" ➝ ")}${titled("gamma.txt")}${dim("}")}`
    );
    expect(paintBody(entries)).toBe("");
  });

  test("rename keeps the common prefix and suffix outside the braces", () => {
    expect(
      paintTitle([
        {
          action: {
            kind: "move",
            path: "/repo/aaa/bbb/test.txt",
            movePath: "/repo/aaa/ccc/test.txt",
          },
          diff: undefined,
        },
      ])
    ).toBe(
      `aaa/${dim("{")}${dim("<s>bbb</s>")}${dim(" ➝ ")}${titled("ccc")}${dim("}")}${titled("/test.txt")}`
    );
  });

  test("rename without a shared segment falls back to a plain arrow", () => {
    expect(
      paintTitle([
        {
          action: {
            kind: "move",
            path: "/repo/aaa/one.txt",
            movePath: "/repo/bbb/two.md",
          },
          diff: undefined,
        },
      ])
    ).toBe(`${dim("<s>aaa/one.txt</s>")} ${dim("➝")} ${titled("bbb/two.md")}`);
  });

  test("move + edit renders Edit with the arrow title and a diff", () => {
    const entries: ApplyEntry[] = [
      {
        action: { kind: "move", path: "/repo/a.ts", movePath: "/repo/b.ts" },
        diff: changeDiff("/repo/b.ts"),
      },
    ];
    expect(view(entries).label).toBe("Edit");
    expect(paintTitle(entries)).toBe(
      `${dim("{")}${dim("<s>a.ts</s>")}${dim(" ➝ ")}${titled("b.ts")}${dim("}")} ${added(1)}/${removed(1)}`
    );
    expect(paintBody(entries)).toContain("BETA");
  });
});

describe("applyPatchView trailing entries", () => {
  test("appends each further file after a blank padding row", () => {
    const body = paintBody([
      {
        action: { kind: "update", path: "/repo/a.txt" },
        diff: changeDiff("/repo/a.txt"),
      },
      {
        action: { kind: "add", path: "/repo/b.txt" },
        diff: addDiff("/repo/b.txt"),
      },
      {
        action: { kind: "delete", path: "/repo/c.txt" },
        diff: removeDiff("/repo/c.txt"),
      },
    ]).split("\n");

    const headers = body.filter((line) => line.startsWith("<success>"));
    expect(headers).toEqual([
      header("Write", `b.txt ${added(2)}`),
      header("Delete", `c.txt ${removed(3)}`),
    ]);
    expect(body.at(-1)).toBe(header("Delete", `c.txt ${removed(3)}`));
    expect(body.filter((line) => line === "")).toHaveLength(2);
  });

  test("a section carries its own separator, even after a body-less entry", () => {
    const body = paintBody([
      {
        action: { kind: "delete", path: "/repo/a.txt" },
        diff: removeDiff("/repo/a.txt"),
      },
      {
        action: { kind: "add", path: "/repo/b.txt" },
        diff: addDiff("/repo/b.txt"),
      },
    ]).split("\n");

    expect(body[0]).toBe("");
    expect(body[1]).toBe(header("Write", `b.txt ${added(2)}`));
  });

  test("a section without stats carries the bare title", () => {
    const body = paintBody([
      {
        action: { kind: "update", path: "/repo/a.txt" },
        diff: changeDiff("/repo/a.txt"),
      },
      {
        action: { kind: "move", path: "/repo/x.txt", movePath: "/repo/y.txt" },
        diff: undefined,
      },
    ]).split("\n");

    expect(body.at(-1)).toBe(
      header(
        "Move",
        `${dim("{")}${dim("<s>x.txt</s>")}${dim(" ➝ ")}${titled("y.txt")}${dim("}")}`
      )
    );
  });

  test("forces the body open so diffs are never hidden behind an expand", () => {
    expect(
      view([
        {
          action: { kind: "update", path: "/repo/a.txt" },
          diff: changeDiff("/repo/a.txt"),
        },
      ]).collapsed
    ).toBe(false);
  });
});
