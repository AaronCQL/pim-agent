import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { DiffLines, type ToolDiffHunk } from "#core/shared/DiffLines";
import type { ChangeSummary } from "#protocol/Diff";
import { mountPoint } from "../test/dom";
import {
  DIFF_EMPHASIS_CLASSES,
  DIFF_FILLER_CLASS,
  DIFF_GAP_CLASS,
} from "../view/tokens";
import type { FileState } from "./DiffStore";
import { FileRow } from "./FileRow";
import { SplitDiff } from "./SplitHunk";

const PATH = "src/alpha.ts";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function hunks(from: string, to: string): readonly ToolDiffHunk[] {
  return (
    DiffLines.buildToolDiff(
      PATH,
      DiffLines.fromText(from),
      DiffLines.fromText(to),
      3
    )?.hunks ?? []
  );
}

function paint(from: string, to: string): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => <SplitDiff path={PATH} hunks={hunks(from, to)} />,
    host
  );
  flush();
  return host;
}

function column(host: HTMLElement, side: "old" | "new"): readonly string[] {
  return [...host.querySelectorAll<HTMLElement>(`[data-side='${side}']`)].map(
    (cell) => cell.textContent ?? ""
  );
}

function shaded(host: HTMLElement, side: "old" | "new"): readonly boolean[] {
  return [...host.querySelectorAll<HTMLElement>(`[data-side='${side}']`)].map(
    (cell) => cell.className.includes(DIFF_FILLER_CLASS)
  );
}

/** The gutter is the cell before its text, so read the numbers off each pair. */
function numbers(host: HTMLElement, side: "old" | "new"): readonly string[] {
  return [...host.querySelectorAll<HTMLElement>(`[data-side='${side}']`)].map(
    (cell) =>
      cell.previousElementSibling?.textContent?.trim().split(" ")[0] ?? ""
  );
}

function summary(): ChangeSummary {
  return {
    path: PATH,
    status: "modified",
    added: 1,
    removed: 1,
    fingerprint: "one",
  };
}

function row(from: string, to: string, split = true): HTMLElement {
  const host = mountPoint();
  const state: FileState = {
    kind: "ready",
    diff: { path: PATH, hunks: hunks(from, to) },
    lines: new Map(),
    opening: false,
  };
  dispose = render(
    () => (
      <FileRow
        file={summary()}
        state={state}
        seen={false}
        split={split}
        onExpand={() => {}}
        onOpen={() => {}}
        onToggleSeen={() => {}}
      />
    ),
    host
  );
  flush();
  host.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  flush();
  return host;
}

test("a replacement zips old against new, row for row", () => {
  const host = paint("one\ntwo\nthree\n", "one\nTWO\nthree\n");

  expect(column(host, "old")).toEqual(["one", "two", "three"]);
  expect(column(host, "new")).toEqual(["one", "TWO", "three"]);
});

test("the shorter side of a run is padded, keeping the two columns level", () => {
  const host = paint("one\ntwo\n", "one\ntwo\nthree\nfour\n");

  expect(column(host, "old")).toEqual(["one", "two", "", ""]);
  expect(column(host, "new")).toEqual(["one", "two", "three", "four"]);
});

test("a half with no line of its own is shaded, not left blank", () => {
  const host = paint("one\ntwo\n", "one\ntwo\nthree\nfour\n");

  expect(shaded(host, "old")).toEqual([false, false, true, true]);
  expect(shaded(host, "new")).toEqual([false, false, false, false]);
});

/* A repeating gradient starts over in every box it is painted in, so a hatched
   gutter beside a hatched line shows the phase break as a crack down the row. */
test("the hatch is one box wide, never split across the gutter", () => {
  const host = paint("one\ntwo\n", "one\ntwo\nthree\n");
  const gutters = [
    ...host.querySelectorAll<HTMLElement>("[data-side='old']"),
  ].map((cell) => cell.previousElementSibling?.className ?? "");

  expect(shaded(host, "old")).toEqual([false, false, true]);
  expect(gutters.every((name) => !name.includes(DIFF_FILLER_CLASS))).toBe(true);
});

test("both sides are cells of one grid, never two scrollers", () => {
  const host = paint("one\ntwo\n", "one\nTWO\n");
  const grids = host.querySelectorAll<HTMLElement>(".grid");
  const cells = [...host.querySelectorAll<HTMLElement>("[data-side]")];

  expect(grids.length).toBe(1);
  expect(cells.length).toBe(4);
  expect(cells.every((cell) => cell.parentElement === grids[0])).toBe(true);
});

test("each side numbers its own file, so a deletion drifts the two apart", () => {
  const host = paint("a\nb\nc\nd\ne\n", "c\nd\ne\n");

  expect(numbers(host, "old")).toEqual(["1", "2", "3", "4", "5"]);
  expect(numbers(host, "new")).toEqual(["", "", "1", "2", "3"]);
});

test("intra-line emphasis survives the split", () => {
  const host = paint("const value = 1;\n", "const value = 2;\n");

  expect(host.innerHTML).toContain(DIFF_EMPHASIS_CLASSES.added);
  expect(host.innerHTML).toContain(DIFF_EMPHASIS_CLASSES.removed);
});

test("a long line wraps inside its half rather than widening it", () => {
  const host = paint("short\n", `${"x".repeat(400)}\n`);
  const grid = host.querySelector<HTMLElement>(".grid");
  const cells = [...host.querySelectorAll<HTMLElement>("[data-side]")];

  // Two `1fr` halves that may shrink below their content, and text that breaks.
  expect(grid?.className).toContain("minmax(0,1fr)_auto_minmax(0,1fr)");
  expect(grid?.className).not.toContain("w-max");
  expect(
    cells.every((cell) => cell.className.includes("whitespace-pre-wrap"))
  ).toBe(true);
  expect(cells.every((cell) => cell.className.includes("wrap-anywhere"))).toBe(
    true
  );
});

test("every hunk of a file is painted, separated by the lines it skips", () => {
  const from = `${["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n")}\n`;
  const host = paint(from, from.replace("a\n", "A\n").replace("j\n", "J\n"));

  expect(column(host, "old")).toContain("a");
  expect(column(host, "new")).toContain("J");
  expect(host.textContent).toContain("2 lines unchanged");
  expect(host.innerHTML).toContain("i-griddy-icons:unfold-more");
  // The skipped middle is a band across both halves, like the halves it stands in for.
  expect(
    host.querySelector(".col-span-full")?.className.includes(DIFF_GAP_CLASS)
  ).toBe(true);
});

test("a desktop row paints two columns", () => {
  const host = row("one\ntwo\n", "one\nTWO\n");

  expect(column(host, "old")).toEqual(["one", "two"]);
  expect(column(host, "new")).toEqual(["one", "TWO"]);
});

test("a narrow row paints one", () => {
  const host = row("one\ntwo\n", "one\nTWO\n", false);

  expect(host.querySelectorAll("[data-side]").length).toBe(0);
  expect(host.textContent).toContain("TWO");
});
