import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { DiffLines, type ToolDiffHunk } from "#core/shared/DiffLines";
import { mountPoint } from "../test/dom";
import { UnifiedDiff } from "./UnifiedDiff";

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
    () => (
      <UnifiedDiff
        path={PATH}
        hunks={hunks(from, to)}
        total={undefined}
        busy={false}
        onOpen={() => {}}
      />
    ),
    host
  );
  flush();
  return host;
}

/**
 * The list of files is the page's only other scroller, and a row wider than it
 * pans everything in it — including the title bars, which are sticky in Y
 * alone and so slide off the left edge with the code. The file keeps its own
 * overflow, and the list stays where it was put.
 */
test("a long line is panned to inside the file, never by the list", () => {
  const host = paint("short\n", `${"x".repeat(400)}\n`);
  const frame = host.firstElementChild as HTMLElement;
  const lines = frame.firstElementChild as HTMLElement;

  expect(frame.className).toContain("overflow-x-auto");
  // As wide as its widest line, and never narrower than the pane behind it.
  expect(lines.className).toContain("w-max");
  expect(lines.className).toContain("min-w-full");
});

test("a line is never re-wrapped: the code is the shape it was written in", () => {
  const host = paint("one\ntwo\n", "one\nTWO\n");
  const rows = [...host.querySelectorAll<HTMLElement>("div.whitespace-pre")];

  expect(rows.map((row) => row.textContent)).toEqual([
    " 1   one",
    " 2 − two",
    " 2 + TWO",
  ]);
  expect(host.innerHTML).not.toContain("wrap-anywhere");
});
