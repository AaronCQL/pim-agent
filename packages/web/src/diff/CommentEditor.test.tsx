import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { DiffLines, type ToolDiffHunk } from "#core/shared/DiffLines";
import type { ChangeSummary } from "#protocol/Diff";
import { mountPoint } from "../test/dom";
import { CommentEditor } from "./CommentEditor";
import { Comments, ReviewComments } from "./Comments";
import type { FileState } from "./DiffStore";
import { FileRow } from "./FileRow";

/**
 * The card is the editor, and on a device with no pointer the editor is a
 * sheet: the same words, written where the soft keyboard leaves room for them.
 */

const PATH = "src/alpha.ts";
const REPO = "/home/dev/repo";
const FROM = "one\ntwo\nthree\n";
const TO = "one\nTWO\nthree\n";

let dispose: (() => void) | undefined;
let realMatchMedia: typeof globalThis.matchMedia | undefined;

/** A device that answers no to "is there a real pointer?", which is a phone. */
function touch(): void {
  realMatchMedia ??= globalThis.matchMedia;
  const real = realMatchMedia.bind(globalThis);
  globalThis.matchMedia = ((query: string) =>
    query.includes("hover")
      ? { matches: false, addEventListener() {}, removeEventListener() {} }
      : real(query)) as typeof globalThis.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  localStorage.clear();
  if (realMatchMedia) {
    globalThis.matchMedia = realMatchMedia;
    realMatchMedia = undefined;
  }
});

type Card = {
  readonly host: HTMLElement;
  readonly written: string[];
  readonly closed: () => number;
  readonly discarded: () => number;
  readonly removed: () => number;
};

function paint(
  extra: {
    readonly text?: string;
    readonly stale?: boolean;
    readonly focus?: boolean;
    readonly editable?: boolean;
  } = {}
): Card {
  const host = mountPoint();
  const written: string[] = [];
  let closed = 0;
  let discarded = 0;
  let removed = 0;
  dispose = render(
    () => (
      <CommentEditor
        path={PATH}
        text={extra.text ?? ""}
        stale={extra.stale === true}
        focus={extra.focus === true}
        editable={extra.editable !== false}
        onWrite={(text) => written.push(text)}
        onClose={() => {
          closed += 1;
        }}
        onDiscard={() => {
          discarded += 1;
        }}
        onRemove={() => {
          removed += 1;
        }}
      />
    ),
    host
  );
  flush();
  return {
    host,
    written,
    closed: () => closed,
    discarded: () => discarded,
    removed: () => removed,
  };
}

function box(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector<HTMLTextAreaElement>("textarea")!;
}

function press(field: HTMLTextAreaElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function blur(field: HTMLTextAreaElement): void {
  field.dispatchEvent(new FocusEvent("blur"));
  flush();
}

test("every keystroke is written through, with nothing to press", () => {
  const card = paint();
  press(box(card.host), "Move");
  press(box(card.host), "Move this");

  expect(card.written).toEqual(["Move", "Move this"]);
  expect(card.host.textContent).not.toContain("Comment");
  expect(card.host.textContent).not.toContain("Cancel");
});

/** No header, no line label, no quote: the card is the comment and nothing else. */
test("the card carries the comment and says nothing about where it hangs", () => {
  const card = paint({ text: "Move this to the trailing edge" });

  expect(box(card.host).value).toBe("Move this to the trailing edge");
  expect(card.host.textContent?.trim()).toBe("");
});

test("a new card opens with the cursor already in it", () => {
  const card = paint({ focus: true });

  expect(document.activeElement).toBe(box(card.host));
});

test("escape closes the editor and leaves what was typed in it", () => {
  const card = paint({ focus: true });
  press(box(card.host), "worth keeping");
  box(card.host).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  flush();

  expect(card.closed()).toBe(1);
  expect(card.removed()).toBe(0);
  expect(card.written).toEqual(["worth keeping"]);
});

/** Typed into, cleared, and walked away from: what is left says nothing. */
test("a card blurred with nothing left in it discards what it held", () => {
  const card = paint({ text: "half a thought" });
  press(box(card.host), "");
  blur(box(card.host));

  expect(card.discarded()).toBe(1);
  expect(card.removed()).toBe(0);
  expect(card.closed()).toBe(0);
});

test("a card holding only blanks is as empty as one holding nothing", () => {
  const card = paint();
  press(box(card.host), "  \n\t ");
  blur(box(card.host));

  expect(card.discarded()).toBe(1);
});

test("a card blurred with words in it is left alone", () => {
  const card = paint({ text: "worth keeping" });
  blur(box(card.host));

  expect(card.discarded()).toBe(0);
  expect(card.removed()).toBe(0);
});

test("the cross is the only way the card goes away", () => {
  const card = paint({ text: "never mind" });
  card.host
    .querySelector<HTMLButtonElement>(
      `[aria-label='Delete the comment on ${PATH}']`
    )
    ?.click();

  expect(card.removed()).toBe(1);
});

/** Amber says one thing on this page, and the card's own ring never says it. */
test("a file that has moved on is chipped beside the card, not around it", () => {
  const stale = paint({ stale: true });
  const fresh = paint({ stale: false });

  expect(stale.host.textContent).toContain("Stale");
  expect(stale.host.firstElementChild?.className).toContain(
    "inset-ring-indigo-400"
  );
  expect(stale.host.firstElementChild?.className).not.toContain("amber");
  expect(fresh.host.textContent).not.toContain("Stale");
});

test("a card with no caret to give hands the tap on instead", () => {
  const card = paint({ text: "read here, written elsewhere", editable: false });
  box(card.host).click();
  flush();

  expect(box(card.host).readOnly).toBe(true);
  expect(card.written).toEqual([]);
});

function hunks(): readonly ToolDiffHunk[] {
  return (
    DiffLines.buildToolDiff(
      PATH,
      DiffLines.fromText(FROM),
      DiffLines.fromText(TO),
      3
    )?.hunks ?? []
  );
}

function summary(): ChangeSummary {
  return {
    path: PATH,
    status: "modified",
    added: 1,
    removed: 1,
    fingerprint: "f1",
  };
}

function row(comments: Comments): HTMLElement {
  const host = mountPoint();
  const state: FileState = {
    kind: "ready",
    diff: { path: PATH, hunks: hunks() },
    lines: new Map(),
    opening: false,
  };
  dispose = render(
    () => (
      <ReviewComments value={() => comments}>
        <FileRow
          file={summary()}
          state={state}
          split={false}
          onExpand={() => {}}
          onOpen={() => {}}
        />
      </ReviewComments>
    ),
    host
  );
  flush();
  host.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  flush();
  return host;
}

function loaded(): Comments {
  const comments = new Comments();
  comments.load(REPO);
  flush();
  return comments;
}

function sheet(host: HTMLElement): HTMLDialogElement {
  return host.querySelector<HTMLDialogElement>("dialog[aria-label='Comment']")!;
}

function sheetBox(host: HTMLElement): HTMLTextAreaElement {
  return sheet(host).querySelector<HTMLTextAreaElement>("textarea")!;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  return [...sheet(host).querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label
  )!;
}

function pick(host: HTMLElement, label: string): void {
  host.querySelector<HTMLButtonElement>(`[aria-label='${label}']`)?.click();
  flush();
}

test("a picked line on a phone is written about in the sheet, not under the row", () => {
  touch();
  const comments = loaded();
  const host = row(comments);

  pick(host, "Comment on new line 2");

  expect(sheet(host).open).toBe(true);
  expect(sheet(host).textContent).toContain("TWO");
  expect(host.querySelectorAll("textarea").length).toBe(1);
});

/**
 * The sheet quotes the file the way the file reads — numbered, signed and
 * washed — and titles itself with the name alone: the path is what the reader
 * just tapped their way through.
 */
test("the sheet quotes the picked line as the diff paints it", () => {
  touch();
  const comments = loaded();
  const host = row(comments);

  pick(host, "Comment on new line 2");
  const quote = sheet(host).querySelector("div")!;

  expect(quote.textContent).toContain(" 2 + TWO");
  expect(sheet(host).innerHTML).toContain("bg-emerald-500/8");
  expect(sheet(host).querySelector("header")?.textContent).toContain(
    "alpha.ts"
  );
  expect(sheet(host).querySelector("header")?.textContent).not.toContain(
    "src/"
  );
});

/**
 * The composer sits on the keyboard rather than halfway up a black screen, and
 * the quote it is answering ends where its last line does — a rule under empty
 * space reads as a pane with nothing in it.
 */
test("the composer keeps the foot and the quote ends with its lines", () => {
  touch();
  const comments = loaded();
  const host = row(comments);

  pick(host, "Comment on new line 2");
  const quote = sheet(host).querySelector("header + div")!;
  const composer = sheetBox(host).parentElement!;

  expect(quote.className).not.toContain("flex-1");
  // It gives way to the composer instead of pushing it off, and scrolls itself.
  expect(quote.className).toContain("min-h-0");
  expect(quote.className).toContain("overflow-auto");
  expect(composer.className).toContain("mt-auto");
  expect(composer.className).toContain("shrink-0");
});

/** A sheet is opened to be written in, so the caret and the keyboard come with it. */
test("the sheet opens with the caret already in it", () => {
  touch();
  const comments = loaded();
  const host = row(comments);

  pick(host, "Comment on new line 2");

  expect(document.activeElement).toBe(sheetBox(host));
  expect(sheetBox(host).autofocus).toBe(true);
});

test("the sheet keeps what it is handed only when it is pressed", () => {
  touch();
  const comments = loaded();
  const host = row(comments);

  pick(host, "Comment on new line 2");
  press(sheetBox(host), "thought better of it");
  button(host, "Cancel").click();
  flush();

  expect(comments.count(PATH)).toBe(0);
  expect(sheet(host).open).toBe(false);

  pick(host, "Comment on new line 2");
  press(sheetBox(host), "said on purpose");
  button(host, "Comment").click();
  flush();

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.text).toBe("said on purpose");
  expect(comments.list(PATH)[0]?.start).toBe(2);
  expect(sheet(host).open).toBe(false);
});

test("a saved comment tapped on a phone reopens in the sheet", () => {
  touch();
  const comments = loaded();
  comments.create(
    { path: PATH, fingerprint: "f1", side: "new", start: 2, quote: "TWO" },
    "said before"
  );
  flush();
  const host = row(comments);

  host.querySelector<HTMLTextAreaElement>("textarea")?.click();
  flush();

  expect(sheetBox(host).value).toBe("said before");
  press(sheetBox(host), "said again");
  button(host, "Comment").click();
  flush();

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.text).toBe("said again");
});

test("a desktop row writes in place and opens no sheet", () => {
  const comments = loaded();
  const host = row(comments);

  pick(host, "Comment on new line 2");

  expect(sheet(host).open).toBe(false);
  expect(document.activeElement).toBe(
    host.querySelector<HTMLTextAreaElement>("textarea")
  );
});
