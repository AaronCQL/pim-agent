import "../test/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { Comments, type CommentAnchor } from "./Comments";

/**
 * A comment is typed by a human, so nothing here ever throws one away: a file
 * that has moved on renders outdated, and only a deliberate `remove` deletes.
 * Nothing is stored before the first keystroke either — a selection walked
 * away from was never a comment.
 */

const KEY = "pim.diff.comments";
const REPO = "/home/dev/repo";
const PATH = "src/alpha.ts";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

function loaded(cwd = REPO): Comments {
  const comments = new Comments();
  comments.load(cwd);
  flush();
  return comments;
}

/** The batched write lands in a microtask, so wait for one rather than for time. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

function stored(): Record<string, readonly { text: string }[]> {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<
    string,
    readonly { text: string }[]
  >;
}

/** Storage that counts, or refuses, every write it is handed. */
async function withStorage(refuse: boolean, run: () => void): Promise<number> {
  const real = localStorage;
  let writes = 0;
  const counted: Storage = {
    ...real,
    getItem: (key: string) => real.getItem(key),
    removeItem: (key: string) => {
      real.removeItem(key);
    },
    clear: () => {
      real.clear();
    },
    key: (index: number) => real.key(index),
    get length() {
      return real.length;
    },
    setItem: (key: string, value: string) => {
      writes += 1;
      if (refuse) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      real.setItem(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: counted,
  });
  try {
    run();
    await settle();
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: real,
    });
  }
  return writes;
}

function anchor(start: number, end = start, fingerprint = "f1"): CommentAnchor {
  return {
    path: PATH,
    fingerprint,
    side: "new",
    start,
    end,
    quote: "one",
  };
}

const FILE: CommentAnchor = { path: PATH, fingerprint: "f1" };

test("a comment is made of a range and the first thing typed into it", () => {
  const comments = loaded();
  comments.create(anchor(12), "move this to the trailing edge");
  flush();

  const [comment] = comments.list(PATH);
  expect(comment?.text).toBe("move this to the trailing edge");
  expect(comment?.side).toBe("new");
  expect(comment?.start).toBe(12);
  expect(comment?.end).toBe(12);
  expect(comment?.quote).toBe("one");
  expect(comments.count(PATH)).toBe(1);
  expect(comments.count("other.ts")).toBe(0);
});

test("a range arrives with its first keystroke, whole", () => {
  const comments = loaded();
  comments.create(anchor(12, 18), "all of this");
  flush();

  expect(comments.list(PATH)[0]?.start).toBe(12);
  expect(comments.list(PATH)[0]?.end).toBe(18);
  expect(comments.count(PATH)).toBe(1);
});

/** The ids are what a row lists, so an edit must leave them exactly as they lay. */
test("a keystroke moves the comment and nothing else", () => {
  const comments = loaded();
  const id = comments.create(anchor(12), "m");
  comments.create(anchor(12), "another");
  flush();
  const before = comments.ids(PATH, "new", 12);

  comments.write(id, "mo");
  flush();
  comments.write(id, "mov");
  flush();

  expect(comments.ids(PATH, "new", 12)).toBe(before);
  expect(before[0]).toBe(id);
  expect(before.length).toBe(2);
  expect(comments.one(id)?.text).toBe("mov");
  expect(comments.count(PATH)).toBe(2);
});

test("a comment on the file itself is listed under no line", () => {
  const comments = loaded();
  const id = comments.create(FILE, "the whole thing");
  comments.create(anchor(12), "and this line");
  flush();

  expect(comments.ids(PATH)).toEqual([id]);
  expect(comments.ids(PATH, "new", 12).length).toBe(1);
  expect(comments.one("nobody")).toBeUndefined();
});

test("a comment outlives the tab that wrote it", async () => {
  const comments = loaded();
  comments.create(anchor(12), "still here");
  await settle();

  const reopened = loaded();
  expect(reopened.list(PATH)[0]?.text).toBe("still here");
  expect(reopened.count(PATH)).toBe(1);
  expect(reopened.all().length).toBe(1);
});

test("removing is the only way a comment goes away", async () => {
  const comments = loaded();
  const id = comments.create(anchor(12), "gone in a moment");
  comments.remove(id);
  flush();
  await settle();

  expect(comments.list(PATH)).toEqual([]);
  expect(comments.count(PATH)).toBe(0);
  expect(stored()[REPO]).toBeUndefined();
  expect(loaded().list(PATH)).toEqual([]);
});

test("a burst of keystrokes is one write, not one write each", async () => {
  const comments = loaded();
  const writes = await withStorage(false, () => {
    const id = comments.create(anchor(12), "m");
    for (const text of ["mo", "mov", "move"]) {
      comments.write(id, text);
    }
  });

  expect(writes).toBe(1);
  expect(stored()[REPO]?.[0]?.text).toBe("move");
});

test("a full quota is not an error a keystroke can raise", async () => {
  const comments = loaded();
  const writes = await withStorage(true, () => {
    expect(() => {
      comments.create(anchor(12), "typed into a full disk");
    }).not.toThrow();
  });
  flush();

  expect(writes).toBe(1);
  expect(comments.list(PATH)[0]?.text).toBe("typed into a full disk");
});

/** The file moved on; the comment still names the code, so it stays. */
test("a comment whose file has changed is kept, fingerprint and all", async () => {
  const comments = loaded();
  comments.create(anchor(12, 12, "f1"), "outdated but read");
  await settle();

  const reopened = loaded();
  expect(reopened.list(PATH)[0]?.fingerprint).toBe("f1");
  expect(reopened.list(PATH)[0]?.text).toBe("outdated but read");
});

test("another working copy's comments are held apart, and neither prunes the other", async () => {
  const comments = loaded();
  comments.create(anchor(12), "in this repo");
  flush();

  comments.load("/home/dev/other");
  flush();
  expect(comments.list(PATH)).toEqual([]);
  expect(comments.all()).toEqual([]);
  comments.create(anchor(3), "in the other one");
  flush();
  await settle();

  comments.load(REPO);
  flush();
  expect(comments.list(PATH).map((held) => held.text)).toEqual([
    "in this repo",
  ]);
  expect(Object.keys(stored())).toEqual([REPO, "/home/dev/other"]);
});

test("a selection widened after the fact takes in the new line", () => {
  const comments = loaded();
  const id = comments.create(anchor(12), "more than one line");
  comments.extend(id, 18);
  flush();

  expect(comments.list(PATH)[0]?.start).toBe(12);
  expect(comments.list(PATH)[0]?.end).toBe(18);
  expect(comments.count(PATH)).toBe(1);
});

test("a range taken upwards still runs from its first line to its last", () => {
  const comments = loaded();
  const id = comments.create(anchor(18), "upwards");
  comments.extend(id, 12);
  flush();

  expect(comments.list(PATH)[0]?.start).toBe(12);
  expect(comments.list(PATH)[0]?.end).toBe(18);
});

test("a comment on the file itself has no side and no line to widen", () => {
  const comments = loaded();
  const id = comments.create(FILE, "no line of its own");
  comments.extend(id, 12);
  flush();

  const [comment] = comments.list(PATH);
  expect(comment?.side).toBeUndefined();
  expect(comment?.start).toBeUndefined();
  expect(comment?.end).toBeUndefined();
});

test("a line answers with its own comments, and its own side's", () => {
  const comments = loaded();
  comments.create(anchor(12), "on the new side");
  comments.create(
    { path: PATH, fingerprint: "f1", side: "old", start: 12 },
    "on the old side"
  );
  comments.create(
    { path: "other.ts", fingerprint: "f2", side: "new", start: 12 },
    "in another file"
  );
  flush();

  expect(comments.at(PATH, "new", 12).map((held) => held.text)).toEqual([
    "on the new side",
  ]);
  expect(comments.at(PATH, "old", 12).length).toBe(1);
  expect(comments.at(PATH, "new", 13)).toEqual([]);
  expect(comments.count(PATH)).toBe(2);
  expect(comments.count("other.ts")).toBe(1);
});

/** Widening moves the card down to the new last line, so it is never read in
    the middle of the lines it speaks about. */
test("a widened comment hangs under the last line it reaches", () => {
  const comments = loaded();
  const id = comments.create(anchor(12), "still here");
  comments.extend(id, 18);
  flush();

  expect(comments.at(PATH, "new", 18).length).toBe(1);
  expect(comments.at(PATH, "new", 12)).toEqual([]);
});

/** The card carries no range label, so the painted gutters are what say how far it reaches. */
test("every line of a range is held, and no line beside it", () => {
  const comments = loaded();
  const id = comments.create(anchor(12, 14), "three lines");
  flush();

  expect(
    [11, 12, 13, 14, 15].map((line) => comments.holds(PATH, "new", line))
  ).toEqual([false, true, true, true, false]);
  expect(comments.holds(PATH, "old", 12)).toBe(false);
  expect(comments.holds("other.ts", "new", 12)).toBe(false);

  comments.remove(id);
  flush();
  expect(comments.holds(PATH, "new", 12)).toBe(false);
});

test("a comment on the file itself holds no line", () => {
  const comments = loaded();
  comments.create(FILE, "the whole thing");
  flush();

  expect(comments.holds(PATH, "new", 1)).toBe(false);
});

test("every comment of the working copy is answered in the order they were written", () => {
  const comments = loaded();
  comments.create(anchor(12), "first");
  comments.create({ path: "other.ts", fingerprint: "f2" }, "second");
  flush();

  expect(comments.all().map((held) => held.text)).toEqual(["first", "second"]);

  comments.clear();
  flush();
  expect(comments.all()).toEqual([]);
  expect(comments.count(PATH)).toBe(0);
});
