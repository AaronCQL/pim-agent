import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { DiffLines, type ToolDiffHunk } from "#core/shared/DiffLines";
import type { ChangeSummary } from "#protocol/Diff";
import { mountPoint } from "../test/dom";
import type { AnchorState } from "../view/anchors";
import { DIFF_ANCHOR_CLASSES, DIFF_FILLER_CLASS } from "../view/tokens";
import { Comments, ReviewComments } from "./Comments";
import type { FileState } from "./DiffStore";
import { FileRow } from "./FileRow";

/**
 * Selecting is not commenting: a gutter click picks lines out and paints them,
 * and only a keystroke puts anything in the store. Everything here is driven
 * through the rows a reader actually clicks on.
 */

const PATH = "src/alpha.ts";
const OTHER = "src/beta.ts";
const REPO = "/home/dev/repo";
const FROM = "one\ntwo\nthree\nfour\nfive\n";
const TO = "one\nTWO\nthree\nfour\nfive\n";

let dispose: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  localStorage.clear();
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

function summary(path: string, fingerprint = "f1"): ChangeSummary {
  return { path, status: "modified", added: 1, removed: 1, fingerprint };
}

/** The text a row is painted from: the pair above unless a test wants its own. */
type Text = { readonly from: string; readonly to: string };

function ready(
  file: ChangeSummary,
  options: { readonly binary?: boolean; readonly text?: Text }
): FileState {
  const text = options.text ?? { from: FROM, to: TO };
  return {
    kind: "ready",
    diff:
      options.binary === true
        ? { path: file.path, hunks: [], binary: true, newBytes: 3200 }
        : { path: file.path, hunks: hunks(text.from, text.to) },
    lines: new Map(),
    opening: false,
  };
}

/** One expanded row per file, all of them onto the same store of comments. */
function rows(
  comments: Comments,
  files: readonly ChangeSummary[],
  options: {
    readonly split?: boolean;
    readonly binary?: boolean;
    readonly text?: Text;
  } = {}
): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => (
      <ReviewComments value={() => comments}>
        {files.map((file) => (
          <FileRow
            file={file}
            state={ready(file, options)}
            split={options.split === true}
            onExpand={() => {}}
            onOpen={() => {}}
          />
        ))}
      </ReviewComments>
    ),
    host
  );
  flush();
  for (const bar of host.querySelectorAll<HTMLButtonElement>(
    "button[aria-expanded]"
  )) {
    bar.click();
  }
  flush();
  return host;
}

function loaded(): Comments {
  const comments = new Comments();
  comments.load(REPO);
  flush();
  return comments;
}

function gutter(host: HTMLElement, label: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[aria-label='${label}']`)!;
}

/** A keyboard activating a gutter, which picks that one line out and settles at once. */
function click(host: HTMLElement, label: string): void {
  gutter(host, label).click();
  flush();
}

/** A shift-click, which is one of the two ways a range is taken. */
function shiftClick(host: HTMLElement, label: string): void {
  gutter(host, label).dispatchEvent(
    new MouseEvent("click", { bubbles: true, shiftKey: true })
  );
  flush();
}

/** A press on a gutter, which paints its line and leaves the pointer down. */
function press(host: HTMLElement, label: string): void {
  gutter(host, label).dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  );
  flush();
}

/** The pointer let go, wherever it happens to be by then. */
function lift(): void {
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  flush();
}

/** A press, a sweep across the gutters between, and a release: the other way. */
function drag(
  host: HTMLElement,
  from: string,
  ...over: readonly string[]
): void {
  press(host, from);
  for (const label of over) {
    gutter(host, label).dispatchEvent(
      new PointerEvent("pointerenter", { buttons: 1 })
    );
    flush();
  }
  lift();
}

function box(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector<HTMLTextAreaElement>("textarea")!;
}

/** One keystroke, as a browser reports it: the value already carries the character. */
function type(
  field: HTMLTextAreaElement,
  text: string,
  caret = text.length
): void {
  field.value = text;
  field.selectionStart = caret;
  field.selectionEnd = caret;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

/** Types into the editor the selection opened, which is the one holding the caret. */
function say(text: string): void {
  type(document.activeElement as HTMLTextAreaElement, text);
}

function cardOf(field: HTMLTextAreaElement): HTMLElement {
  return field.closest<HTMLElement>("div[class*='inset-ring-indigo-400']")!;
}

/** The four cells of the grid row a card hangs in: old gutter, old text, new gutter, new text. */
function cellsAround(card: Element, side: "old" | "new"): readonly Element[] {
  const cell = card.parentElement!;
  const cells = [...(cell.parentElement?.children ?? [])];
  const first = cells.indexOf(cell) - (side === "old" ? 1 : 3);
  return cells.slice(first, first + 4);
}

/** How every gutter of one side reads, by line number. */
function painted(
  host: HTMLElement,
  side: "old" | "new"
): Record<number, AnchorState> {
  const states: Record<number, AnchorState> = {};
  for (const button of host.querySelectorAll<HTMLButtonElement>(
    `[aria-label^='Comment on ${side} line ']`
  )) {
    const line = Number(button.getAttribute("aria-label")?.split(" ").pop());
    states[line] = button.className.includes(DIFF_ANCHOR_CLASSES.held)
      ? "held"
      : "idle";
  }
  return states;
}

test("a picked gutter puts nothing in the store until something is typed", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");

  expect(comments.count(PATH)).toBe(0);
  expect(painted(host, "new")[2]).toBe("held");
  expect(host.querySelectorAll("textarea").length).toBe(1);

  say("M");

  expect(comments.count(PATH)).toBe(1);
  const [held] = comments.list(PATH);
  expect(held?.side).toBe("new");
  expect(held?.start).toBe(2);
  expect(held?.end).toBe(2);
  expect(held?.quote).toBe("TWO");
  expect(held?.text).toBe("M");
});

/** The editor a reader walks away from never existed, so there is nothing to clean up. */
test("a selection walked away from leaves nothing behind", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  box(host).dispatchEvent(new FocusEvent("blur"));
  flush();

  expect(comments.count(PATH)).toBe(0);
  expect(comments.all()).toEqual([]);
});

test("escape closes the editor and keeps what was typed", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  say("worth keeping");
  box(host).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  flush();

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.text).toBe("worth keeping");
  expect(painted(host, "new")[2]).toBe("held");
  expect(host.querySelectorAll("textarea").length).toBe(1);
});

test("the first keystroke makes one comment and every keystroke after it edits that one", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  const field = box(host);

  for (const text of ["M", "Mo", "Mov", "Move"]) {
    type(field, text);
    expect(box(host)).toBe(field);
    expect(field.isConnected).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(comments.count(PATH)).toBe(1);
  }

  expect(host.querySelectorAll("textarea").length).toBe(1);
  expect(comments.list(PATH)[0]?.text).toBe("Move");
});

test("a character typed into the middle leaves the caret after it", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  const field = box(host);
  type(field, "move ths line");
  type(field, "move this line", 8);

  expect(box(host)).toBe(field);
  expect(box(host).selectionStart).toBe(8);
  expect(comments.list(PATH)[0]?.text).toBe("move this line");
});

/**
 * The bug that made ranges unusable: the second gutter blurred the empty
 * editor, which deleted the comment and started another one a line later.
 */
test("shift-clicking a second gutter holds one comment over the whole range", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  shiftClick(host, "Comment on new line 4");
  say("all three of these");

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.start).toBe(2);
  expect(comments.list(PATH)[0]?.end).toBe(4);
  expect(comments.list(PATH)[0]?.quote).toBe("TWO");
  expect(host.querySelectorAll("textarea").length).toBe(1);
});

/**
 * A press picks the lines out and nothing more: the reader is still choosing
 * them, and a box over the lines they are sweeping is in the way of the one
 * thing they are looking at.
 */
test("the editor opens when the pointer is lifted, not when it goes down", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  press(host, "Comment on new line 2");

  expect(painted(host, "new")[2]).toBe("held");
  expect(host.querySelectorAll("textarea").length).toBe(0);

  lift();

  expect(painted(host, "new")[2]).toBe("held");
  expect(host.querySelectorAll("textarea").length).toBe(1);
});

/** The release lands wherever the reader stopped, which is rarely a gutter. */
test("a range is settled by a release anywhere on the page", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  press(host, "Comment on new line 2");
  gutter(host, "Comment on new line 4").dispatchEvent(
    new PointerEvent("pointerenter", { buttons: 1 })
  );
  flush();
  expect(host.querySelectorAll("textarea").length).toBe(0);

  document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  flush();
  say("all three of these");

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.start).toBe(2);
  expect(comments.list(PATH)[0]?.end).toBe(4);
});

test("a drag across the gutters holds one comment over the whole range", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  drag(
    host,
    "Comment on new line 2",
    "Comment on new line 3",
    "Comment on new line 4"
  );
  expect(painted(host, "new")).toMatchObject({
    1: "idle",
    2: "held",
    3: "held",
    4: "held",
    5: "idle",
  });

  say("all three of these");

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.start).toBe(2);
  expect(comments.list(PATH)[0]?.end).toBe(4);
});

test("a range taken upwards runs from its first line to its last", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  drag(host, "Comment on new line 4", "Comment on new line 2");
  say("upwards");

  expect(comments.list(PATH)[0]?.start).toBe(2);
  expect(comments.list(PATH)[0]?.end).toBe(4);
  expect(comments.count(PATH)).toBe(1);
});

test("a range widened after it was written takes in the new line", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  say("and one more");
  shiftClick(host, "Comment on new line 3");

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.end).toBe(3);
});

/** `extend` used to no-op across sides, quietly starting a second comment. */
test("a gutter on the other side starts its own selection rather than extending", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)], { split: true });

  click(host, "Comment on new line 2");
  shiftClick(host, "Comment on old line 4");
  say("the old side");

  expect(comments.count(PATH)).toBe(1);
  const [held] = comments.list(PATH);
  expect(held?.side).toBe("old");
  expect(held?.start).toBe(4);
  expect(held?.end).toBe(4);
  expect(painted(host, "new")[2]).toBe("idle");
});

test("a plain click on a second gutter picks that line alone", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  click(host, "Comment on new line 4");
  say("only the fourth");

  expect(comments.list(PATH)[0]?.start).toBe(4);
  expect(comments.list(PATH)[0]?.end).toBe(4);
  expect(painted(host, "new")[2]).toBe("idle");
});

test("every gutter a saved comment holds is painted, and no other", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  drag(host, "Comment on new line 2", "Comment on new line 3");
  say("two lines");
  box(host).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  flush();

  expect(painted(host, "new")).toMatchObject({
    1: "idle",
    2: "held",
    3: "held",
    4: "idle",
  });
});

test("a card hangs under its own row and under no other", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH), summary(OTHER)]);

  click(host, "Comment on new line 2");
  say("the first file");

  const cards = [...host.querySelectorAll("textarea")];
  const files = [...host.querySelectorAll("[aria-expanded]")];
  expect(cards.length).toBe(1);
  expect(files.length).toBe(2);
  expect(cards[0]?.closest("div.border-b")).toBe(
    files[0]?.closest("div.border-b") as Element
  );
});

test("a tap in another file starts its own comment rather than widening", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH), summary(OTHER)]);
  const taps = [
    ...host.querySelectorAll<HTMLButtonElement>(
      "button[aria-label='Comment on new line 2']"
    ),
  ];

  taps[0]?.click();
  flush();
  say("the first file");
  taps[1]?.click();
  flush();
  say("the second file");

  expect(taps.length).toBe(2);
  expect(comments.count(PATH)).toBe(1);
  expect(comments.count(OTHER)).toBe(1);
  expect(comments.list(OTHER)[0]?.start).toBe(2);
});

test("the bar counts the comments its file is carrying", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH), summary(OTHER)]);
  const bar = (path: string): string =>
    host.querySelector(`[aria-label='${path}']`)?.textContent ?? "";

  expect(bar(PATH)).not.toContain("2");

  click(host, "Comment on new line 1");
  shiftClick(host, "Comment on new line 3");
  say("the first range");
  click(host, "Comment on new line 5");
  say("the second one");

  expect(comments.count(PATH)).toBe(2);
  expect(bar(PATH)).toContain("2");
  expect(bar(OTHER)).not.toContain("2");
});

/** Each column is its own file: a remark about the old line is not about the new one. */
test("a split comment sits in the column it was written in", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)], { split: true });

  click(host, "Comment on old line 2");
  say("why was this taken away?");

  const card = cardOf(box(host));
  const cells = cellsAround(card, "old");

  expect(comments.at(PATH, "old", 2)[0]?.quote).toBe("two");
  expect(comments.at(PATH, "new", 2)).toEqual([]);
  expect(cells[1]?.contains(card)).toBe(true);
  expect(cells[3]?.childElementCount).toBe(0);
  expect(cells[3]?.textContent).toBe("");
  expect(painted(host, "old")[2]).toBe("held");
  expect(painted(host, "new")[2]).toBe("idle");
});

test("both sides of one pair carry their own comment, side by side", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)], { split: true });

  click(host, "Comment on old line 2");
  say("the old side");
  click(host, "Comment on new line 2");
  say("the new side");

  expect(comments.count(PATH)).toBe(2);
  expect(comments.at(PATH, "old", 2).length).toBe(1);
  expect(comments.at(PATH, "new", 2).length).toBe(1);
  const cards = [...host.querySelectorAll("textarea")].map(cardOf);
  const cells = cellsAround(cards[0]!, "old");
  expect(cells[1]?.contains(cards[0]!)).toBe(true);
  expect(cells[3]?.contains(cards[1]!)).toBe(true);
});

/** A hatch says this side has no line there, and a comment row is not a line. */
test("the gutter of a comment row carries the hold, never the hatch", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)], { split: true });

  click(host, "Comment on old line 2");
  say("the old side");

  const cells = cellsAround(cardOf(box(host)), "old");
  expect(cells[0]?.className).toBe(DIFF_ANCHOR_CLASSES.held);
  expect(cells[0]?.textContent).toBe("");
  expect(cells[2]?.className).toContain("border-l");
  expect(cells[2]?.className).not.toContain(DIFF_ANCHOR_CLASSES.held);
});

/**
 * A range drawn across a stretch this side has no lines for — the other side
 * gained some — is one hold rather than two with a hole down the middle.
 */
test("a filler inside a range is held with the lines either side of it", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)], {
    split: true,
    text: { from: "one\ntwo\nthree\n", to: "one\nTWO\nextra\nthree\n" },
  });
  const filler = (): string =>
    [...host.querySelectorAll<HTMLElement>("[data-side='old']")].find((cell) =>
      cell.className.includes(DIFF_FILLER_CLASS)
    )?.previousElementSibling?.className ?? "";

  click(host, "Comment on old line 2");

  expect(filler()).not.toContain(DIFF_ANCHOR_CLASSES.held);

  shiftClick(host, "Comment on old line 3");

  expect(filler()).toContain(DIFF_ANCHOR_CLASSES.held);
});

/** A row of cells per pair would double the grid to lay out nothing. */
test("only the pair carrying a comment is given a row for it", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)], { split: true });
  const grid = host.querySelector(".grid")!;
  const pairs = host.querySelectorAll("[data-side='old']").length;

  expect(grid.children.length).toBe(pairs * 4);

  click(host, "Comment on old line 2");
  say("the old side");

  expect(grid.children.length).toBe((pairs + 1) * 4);
});

test("a saved comment is reopened by clicking the words in it", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  say("half a thought");
  box(host).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  flush();

  box(host).click();
  type(box(host), "half a thought, finished");

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.text).toBe("half a thought, finished");
});

/** Where a file has no line to point at, what it says instead is the target. */
test("a file with no textual changes is itself the anchor", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)], { binary: true });

  expect(host.textContent).toContain("binary file 3.2 kB");
  expect(host.textContent).not.toContain("add comment");

  gutter(host, `Comment on ${PATH}`).click();
  flush();
  say("what is this doing here?");

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.side).toBeUndefined();
  expect(comments.list(PATH)[0]?.start).toBeUndefined();
});

test("a comment written before the file changed is marked stale, and keeps its card", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH, "f1")]);

  click(host, "Comment on new line 2");
  say("still worth saying");
  expect(host.textContent).not.toContain("Stale");

  dispose?.();
  dispose = undefined;
  const moved = rows(comments, [summary(PATH, "f2")]);
  const card = cardOf(box(moved));

  expect(card.textContent).toContain("Stale");
  expect(card.className).toContain("inset-ring-indigo-400");
  expect(card.className).not.toContain("amber");
  expect(comments.count(PATH)).toBe(1);
});

test("the cross deletes the comment its card carries", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  click(host, "Comment on new line 2");
  say("never mind");
  host
    .querySelector<HTMLButtonElement>(
      `[aria-label='Delete the comment on ${PATH}']`
    )
    ?.click();
  flush();

  expect(comments.count(PATH)).toBe(0);
  expect(host.querySelectorAll("textarea").length).toBe(0);
  expect(painted(host, "new")[2]).toBe("idle");
});
