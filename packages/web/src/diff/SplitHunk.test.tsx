import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { DiffLines, type ToolDiffHunk } from "#core/shared/DiffLines";
import type { ChangeSummary } from "#protocol/Diff";
import { mountPoint } from "../test/dom";
import { DIFF_EMPHASIS_CLASSES } from "../view/tokens";
import type { FileState } from "./DiffStore";
import { FileRow } from "./FileRow";
import { SplitDiff } from "./SplitHunk";

const PATH = "src/alpha.ts";

let dispose: (() => void) | undefined;
let realMatchMedia: typeof globalThis.matchMedia | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  if (realMatchMedia) {
    globalThis.matchMedia = realMatchMedia;
    realMatchMedia = undefined;
  }
});

/** A narrow viewport: the one query the switch asks stops matching. */
function phone(): void {
  realMatchMedia ??= globalThis.matchMedia;
  const real = realMatchMedia.bind(globalThis);
  globalThis.matchMedia = ((query: string) =>
    query.includes("min-width")
      ? { matches: false, addEventListener() {}, removeEventListener() {} }
      : real(query)) as typeof globalThis.matchMedia;
}

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

function summary(): ChangeSummary {
  return {
    path: PATH,
    status: "modified",
    added: 1,
    removed: 1,
    fingerprint: "one",
  };
}

function row(from: string, to: string): HTMLElement {
  const host = mountPoint();
  const state: FileState = {
    kind: "ready",
    diff: { path: PATH, hunks: hunks(from, to) },
  };
  dispose = render(
    () => (
      <FileRow
        file={summary()}
        state={state}
        seen={false}
        onExpand={() => {}}
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

test("both sides are cells of one grid, never two scrollers", () => {
  const host = paint("one\ntwo\n", "one\nTWO\n");
  const grids = host.querySelectorAll<HTMLElement>(".grid");
  const cells = [...host.querySelectorAll<HTMLElement>("[data-side]")];

  expect(grids.length).toBe(1);
  expect(cells.length).toBe(4);
  expect(cells.every((cell) => cell.parentElement === grids[0])).toBe(true);
});

test("intra-line emphasis survives the split", () => {
  const host = paint("const value = 1;\n", "const value = 2;\n");

  expect(host.innerHTML).toContain(DIFF_EMPHASIS_CLASSES.added);
  expect(host.innerHTML).toContain(DIFF_EMPHASIS_CLASSES.removed);
});

test("every hunk of a file is painted, separated by a gap marker", () => {
  const from = `${["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n")}\n`;
  const host = paint(from, from.replace("a\n", "A\n").replace("j\n", "J\n"));

  expect(column(host, "old")).toContain("a");
  expect(column(host, "new")).toContain("J");
  expect(host.textContent).toContain("⋯");
});

test("a desktop row paints two columns", () => {
  const host = row("one\ntwo\n", "one\nTWO\n");

  expect(column(host, "old")).toEqual(["one", "two"]);
  expect(column(host, "new")).toEqual(["one", "TWO"]);
});

test("a narrow row paints one", () => {
  phone();
  const host = row("one\ntwo\n", "one\nTWO\n");

  expect(host.querySelectorAll("[data-side]").length).toBe(0);
  expect(host.textContent).toContain("TWO");
});
