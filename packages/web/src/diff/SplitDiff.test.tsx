import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";

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
import { SplitDiff } from "./SplitDiff";

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
  const [open, setOpen] = createSignal(false);
  dispose = render(
    () => (
      <FileRow
        file={summary()}
        state={state}
        split={split}
        open={open()}
        onToggle={() => {
          setOpen(!open());
        }}
        onOpen={() => {}}
      />
    ),
    host
  );
  flush();
  host.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  flush();
  return host;
}

test("the shorter side of a run is padded with shaded fillers", () => {
  const host = paint("one\ntwo\n", "one\ntwo\nthree\nfour\n");

  expect(column(host, "old")).toEqual(["one", "two", "", ""]);
  expect(column(host, "new")).toEqual(["one", "two", "three", "four"]);
  expect(shaded(host, "old")).toEqual([false, false, true, true]);
  expect(shaded(host, "new")).toEqual([false, false, false, false]);
});

// A hatch split across gutter and text would show a seam.
test("the hatch is one box wide, never split across the gutter", () => {
  const host = paint("one\ntwo\n", "one\ntwo\nthree\n");
  const gutters = [
    ...host.querySelectorAll<HTMLElement>("[data-side='old']"),
  ].map((cell) => cell.previousElementSibling?.className ?? "");

  expect(shaded(host, "old")).toEqual([false, false, true]);
  expect(gutters.every((name) => !name.includes(DIFF_FILLER_CLASS))).toBe(true);
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

test("every hunk of a file is painted, separated by the lines it skips", () => {
  const from = `${["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n")}\n`;
  const host = paint(from, from.replace("a\n", "A\n").replace("j\n", "J\n"));

  expect(column(host, "old")).toContain("a");
  expect(column(host, "new")).toContain("J");
  expect(host.textContent).toContain("2 lines unchanged");
  expect(host.innerHTML).toContain("i-griddy-icons:unfold-more");
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
