import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import type { SearchRange } from "#core/session/SearchIndex";
import { mountPoint } from "../test/dom";
import { Marked } from "./Marked";

/**
 * The renderer both the title and the snippets of a search row go through. The
 * ranges are the server's, and a row that threw or lost a word on a bad one
 * would be a blank line where the reason it matched should be.
 */

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function paint(text: string, ranges: readonly SearchRange[]): HTMLElement {
  const host = mountPoint();
  dispose = render(() => <Marked text={text} ranges={ranges} />, host);
  flush();
  return host;
}

function marks(host: HTMLElement): readonly (string | null)[] {
  return [...host.querySelectorAll("mark")].map((mark) => mark.textContent);
}

test("marks the spans the server chose and nothing else", () => {
  const host = paint("Who holds the turn lease?", [[19, 24]]);

  expect(marks(host)).toEqual(["lease"]);
  expect(host.textContent).toBe("Who holds the turn lease?");
});

test("marks a word the query never contained", () => {
  // `sidbar` marked `sidebar`, `lease` marked the `Lease` of `SessionLease`:
  // the client draws what the planner reached for, not what was typed.
  const host = paint("The SessionLease guards a whole turn", [[11, 16]]);

  expect(marks(host)).toEqual(["Lease"]);
});

test("draws a run of ranges as a mark apiece", () => {
  const host = paint("lease, lease and lease again", [
    [0, 5],
    [7, 12],
    [17, 22],
  ]);

  expect(marks(host)).toEqual(["lease", "lease", "lease"]);
  expect(host.textContent).toBe("lease, lease and lease again");
});

test("text nothing matched is drawn whole", () => {
  const host = paint("Nothing interesting here yet.", []);

  expect(marks(host)).toEqual([]);
  expect(host.textContent).toBe("Nothing interesting here yet.");
});

test("a range past the end of the text loses none of it", () => {
  const text = "the lease";

  expect(paint(text, [[4, 99]]).textContent).toBe(text);
  dispose?.();
  expect(paint(text, [[40, 99]]).textContent).toBe(text);
  dispose?.();
  expect(paint(text, [[-4, 3]]).textContent).toBe(text);
});

test("overlapping or unordered ranges repeat no character and drop none", () => {
  const text = "the turn lease";

  const overlapping = paint(text, [
    [4, 9],
    [6, 14],
  ]);
  expect(overlapping.textContent).toBe(text);
  expect(marks(overlapping)).toEqual(["turn ", "lease"]);

  dispose?.();
  const backwards = paint(text, [
    [9, 14],
    [0, 3],
  ]);
  expect(backwards.textContent).toBe(text);
  expect(marks(backwards)).toEqual(["lease"]);
});

test("an empty or inverted range is no mark at all", () => {
  const host = paint("the lease", [
    [4, 4],
    [8, 5],
  ]);

  expect(marks(host)).toEqual([]);
  expect(host.textContent).toBe("the lease");
});
