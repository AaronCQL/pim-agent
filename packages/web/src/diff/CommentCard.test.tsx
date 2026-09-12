import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { DiffLines, type ToolDiffHunk } from "#core/shared/DiffLines";
import type { ViewBlock } from "#core/view/ViewBlock";
import type { ChangeSummary } from "#protocol/Diff";
import { mountPoint } from "../test/dom";
import { Blocks } from "../view/Blocks";
import { CommentCard } from "./CommentCard";
import { Comments, ReviewComments, type Comment } from "./Comments";
import type { FileState } from "./DiffStore";
import { FileRow } from "./FileRow";

/**
 * The card is the editor: there is no Save, so what is typed is what is
 * stored, and the gutter it hangs from is what says which lines it is about.
 */

const PATH = "src/alpha.ts";
const OTHER = "src/beta.ts";
const REPO = "/home/dev/repo";
const FROM = "one\ntwo\nthree\n";
const TO = "one\nTWO\nthree\n";

let dispose: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  localStorage.clear();
});

function comment(extra: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    path: PATH,
    side: "new",
    start: 141,
    end: 141,
    quote: "const w = 1;",
    fingerprint: "f1",
    text: "",
    createdAt: 1,
    ...extra,
  };
}

type Card = {
  readonly host: HTMLElement;
  readonly written: string[];
  readonly removed: number;
};

function paint(
  held: Comment,
  extra: { readonly outdated?: boolean; readonly focus?: boolean } = {}
): Card {
  dispose?.();
  const host = mountPoint();
  const written: string[] = [];
  const card = { host, written, removed: 0 };
  dispose = render(
    () => (
      <CommentCard
        comment={held}
        outdated={extra.outdated === true}
        focus={extra.focus === true}
        onWrite={(text) => written.push(text)}
        onRemove={() => {
          card.removed += 1;
        }}
      />
    ),
    host
  );
  flush();
  return card;
}

function box(host: HTMLElement): HTMLTextAreaElement {
  return host.querySelector("textarea") as HTMLTextAreaElement;
}

/** Says something in the card last opened, which is what keeps it once focus moves on. */
function say(host: HTMLElement, text: string): void {
  const cards = [...host.querySelectorAll("textarea")];
  const field = cards[cards.length - 1] as HTMLTextAreaElement;
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

test("a one-line comment says which line, a range says both", () => {
  expect(paint(comment()).host.textContent).toContain("line 141");
  expect(paint(comment({ end: 147 })).host.textContent).toContain(
    "lines 141–147"
  );
  expect(
    paint(comment({ side: undefined, start: undefined, end: undefined })).host
      .textContent
  ).toContain("whole file");
});

test("every keystroke is written through, with nothing to press", () => {
  const card = paint(comment());
  say(card.host, "Move");
  say(card.host, "Move this");

  expect(card.written).toEqual(["Move", "Move this"]);
  expect(card.host.textContent).not.toContain("Save");
});

test("a card blurred with nothing in it deletes itself", () => {
  const empty = paint(comment());
  box(empty.host).dispatchEvent(new FocusEvent("blur"));
  flush();
  expect(empty.removed).toBe(1);

  const written = paint(comment({ text: "worth keeping" }));
  box(written.host).dispatchEvent(new FocusEvent("blur"));
  flush();
  expect(written.removed).toBe(0);
});

test("the cross deletes a comment that has something in it", () => {
  const card = paint(comment({ text: "worth keeping" }));
  card.host
    .querySelector<HTMLButtonElement>(
      `[aria-label='Delete the comment on ${PATH}']`
    )
    ?.click();

  expect(card.removed).toBe(1);
});

test("a file that has moved on is marked, never dropped", () => {
  expect(paint(comment(), { outdated: true }).host.textContent).toContain(
    "outdated"
  );
  expect(paint(comment()).host.textContent).not.toContain("outdated");
});

test("a new comment opens with the cursor already in it", () => {
  const card = paint(comment(), { focus: true });

  expect(document.activeElement).toBe(box(card.host));
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

function ready(file: ChangeSummary): FileState {
  return {
    kind: "ready",
    diff: { path: file.path, hunks: hunks(FROM, TO) },
    lines: new Map(),
    opening: false,
  };
}

/** One expanded row per file, all of them onto the same store of comments. */
function rows(
  comments: Comments,
  files: readonly ChangeSummary[],
  split = false
): HTMLElement {
  const host = mountPoint();
  dispose = render(
    () => (
      <ReviewComments value={() => comments}>
        {files.map((file) => (
          <FileRow
            file={file}
            state={ready(file)}
            picked={false}
            split={split}
            onExpand={() => {}}
            onOpen={() => {}}
            onTogglePicked={() => {}}
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

function pills(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll("textarea")].map(
    (field) => field.parentElement?.querySelector("span")?.textContent ?? ""
  );
}

test("a tapped gutter anchors a comment to that line, on the side it was tapped", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  gutter(host, "Comment on new line 2").click();
  flush();

  const [held] = comments.list(PATH);
  expect(held?.side).toBe("new");
  expect(held?.start).toBe(2);
  expect(held?.end).toBe(2);
  expect(held?.quote).toBe("TWO");
  expect(pills(host)).toEqual(["line 2"]);
});

test("a second tap in the same file widens the range it opened", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  gutter(host, "Comment on new line 1").click();
  flush();
  gutter(host, "Comment on new line 3").click();
  flush();

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.start).toBe(1);
  expect(comments.list(PATH)[0]?.end).toBe(3);
  expect(pills(host)).toEqual(["lines 1–3"]);
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
  say(host, "the first file");
  taps[1]?.click();
  flush();
  say(host, "the second file");

  expect(taps.length).toBe(2);
  expect(comments.count(PATH)).toBe(1);
  expect(comments.count(OTHER)).toBe(1);
  expect(comments.list(OTHER)[0]?.start).toBe(2);
});

test("a card hangs under its own row and under no other", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH), summary(OTHER)]);

  gutter(host, "Comment on new line 2").click();
  flush();

  const cards = [...host.querySelectorAll("textarea")];
  expect(cards.length).toBe(1);
  const rowsOf = host.querySelectorAll("[aria-expanded]");
  expect(rowsOf.length).toBe(2);
  expect(cards[0]?.closest("div.border-b")).toBe(
    rowsOf[0]?.closest("div.border-b") as Element
  );
});

test("the bar counts the comments its file is carrying", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH), summary(OTHER)]);
  const bar = (path: string): string =>
    host.querySelector(`[aria-label='${path}']`)?.textContent ?? "";

  expect(bar(PATH)).not.toContain("2");

  gutter(host, "Comment on new line 1").click();
  flush();
  gutter(host, "Comment on new line 3").click();
  flush();
  gutter(host, "Comment on new line 2").click();
  flush();

  expect(comments.count(PATH)).toBe(2);
  expect(bar(PATH)).toContain("2");
  expect(bar(OTHER)).not.toContain("2");
});

test("the file itself can be commented on, with no line to its name", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)]);

  [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes("add comment"))
    ?.click();
  flush();

  expect(comments.count(PATH)).toBe(1);
  expect(comments.list(PATH)[0]?.side).toBeUndefined();
  expect(pills(host)).toEqual(["whole file"]);
});

test("a comment written before the file changed reads outdated", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH, "f1")]);

  gutter(host, "Comment on new line 2").click();
  flush();
  expect(host.textContent).not.toContain("outdated");

  dispose?.();
  dispose = undefined;
  const moved = rows(comments, [summary(PATH, "f2")]);
  expect(moved.textContent).toContain("outdated");
  expect(comments.count(PATH)).toBe(1);
});

test("each column of a split anchors its own side, and a range never crosses", () => {
  const comments = loaded();
  const host = rows(comments, [summary(PATH)], true);

  gutter(host, "Comment on old line 2").click();
  flush();
  say(host, "the old side");
  gutter(host, "Comment on new line 2").click();
  flush();
  say(host, "the new side");

  expect(comments.count(PATH)).toBe(2);
  expect(comments.at(PATH, "old", 2).length).toBe(1);
  expect(comments.at(PATH, "new", 2).length).toBe(1);
  expect(comments.at(PATH, "old", 2)[0]?.quote).toBe("two");
  expect(comments.at(PATH, "new", 2)[0]?.quote).toBe("TWO");

  gutter(host, "Comment on new line 3").click();
  flush();
  expect(comments.count(PATH)).toBe(2);
  expect(comments.at(PATH, "new", 2)[0]?.end).toBe(3);
  expect(comments.at(PATH, "old", 2)[0]?.end).toBe(2);
});

const TOOL_DIFF: ViewBlock = {
  kind: "diff",
  path: "greeter.ts",
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: "context", text: "keep", oldLine: 1, newLine: 1 },
        { kind: "removed", text: "old", oldLine: 2 },
        { kind: "added", text: "new", newLine: 2 },
      ],
    },
  ],
};

/** The same painter serves a tool card, where a gutter is text and nothing else. */
test("a tool card's diff is painted with no gutter to tap", () => {
  const host = mountPoint();
  dispose = render(() => <Blocks blocks={[TOOL_DIFF]} />, host);
  flush();

  expect(host.textContent).toContain("keep");
  expect(host.querySelectorAll("button").length).toBe(0);
});
