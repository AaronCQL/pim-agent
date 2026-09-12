import "../test/dom";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { flush } from "solid-js";

import { Comments } from "./Comments";

/**
 * A comment is typed by a human, so nothing here ever throws one away: a file
 * that has moved on renders outdated, and only a deliberate `remove` deletes.
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

function anchor(line: number, fingerprint = "f1") {
  return { path: PATH, fingerprint, side: "new" as const, line, quote: "one" };
}

test("a comment is opened empty, written into, and read back by its path", () => {
  const comments = loaded();
  const id = comments.open(anchor(12));
  comments.write(id, "move this to the trailing edge");
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

test("a comment outlives the tab that wrote it", async () => {
  const comments = loaded();
  comments.write(comments.open(anchor(12)), "still here");
  await settle();

  const reopened = loaded();
  expect(reopened.list(PATH)[0]?.text).toBe("still here");
  expect(reopened.count(PATH)).toBe(1);
  expect(reopened.all().length).toBe(1);
});

test("removing is the only way a comment goes away", async () => {
  const comments = loaded();
  const id = comments.open(anchor(12));
  comments.write(id, "gone in a moment");
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
  const id = comments.open(anchor(12));
  const writes = await withStorage(false, () => {
    for (const text of ["m", "mo", "mov", "move"]) {
      comments.write(id, text);
    }
  });

  expect(writes).toBe(1);
  expect(stored()[REPO]?.[0]?.text).toBe("move");
});

test("a full quota is not an error a keystroke can raise", async () => {
  const comments = loaded();
  const id = comments.open(anchor(12));
  const writes = await withStorage(true, () => {
    expect(() => {
      comments.write(id, "typed into a full disk");
    }).not.toThrow();
  });
  flush();

  expect(writes).toBe(1);
  expect(comments.list(PATH)[0]?.text).toBe("typed into a full disk");
});

/** The file moved on; the comment still names the code, so it stays. */
test("a comment whose file has changed is kept, fingerprint and all", async () => {
  const comments = loaded();
  comments.write(comments.open(anchor(12, "f1")), "outdated but read");
  await settle();

  const reopened = loaded();
  expect(reopened.list(PATH)[0]?.fingerprint).toBe("f1");
  expect(reopened.list(PATH)[0]?.text).toBe("outdated but read");
});

test("another working copy's comments are held apart, and neither prunes the other", async () => {
  const comments = loaded();
  comments.write(comments.open(anchor(12)), "in this repo");
  flush();

  comments.load("/home/dev/other");
  flush();
  expect(comments.list(PATH)).toEqual([]);
  expect(comments.all()).toEqual([]);
  comments.write(comments.open(anchor(3)), "in the other one");
  flush();
  await settle();

  comments.load(REPO);
  flush();
  expect(comments.list(PATH).map((held) => held.text)).toEqual([
    "in this repo",
  ]);
  expect(Object.keys(stored())).toEqual([REPO, "/home/dev/other"]);
});

test("a second tap widens the range rather than starting another comment", () => {
  const comments = loaded();
  const id = comments.open(anchor(12));
  comments.extend(id, 18);
  flush();

  expect(comments.list(PATH)[0]?.start).toBe(12);
  expect(comments.list(PATH)[0]?.end).toBe(18);
  expect(comments.count(PATH)).toBe(1);
});

test("a range taken upwards still runs from its first line to its last", () => {
  const comments = loaded();
  const id = comments.open(anchor(18));
  comments.extend(id, 12);
  flush();

  expect(comments.list(PATH)[0]?.start).toBe(12);
  expect(comments.list(PATH)[0]?.end).toBe(18);
});

test("a comment on the file itself has no side and no line to widen", () => {
  const comments = loaded();
  const id = comments.open({ path: PATH, fingerprint: "f1" });
  comments.extend(id, 12);
  flush();

  const [comment] = comments.list(PATH);
  expect(comment?.side).toBeUndefined();
  expect(comment?.start).toBeUndefined();
  expect(comment?.end).toBeUndefined();
});

test("a line answers with its own comments, and its own side's", () => {
  const comments = loaded();
  comments.write(comments.open(anchor(12)), "on the new side");
  comments.open({ path: PATH, fingerprint: "f1", side: "old", line: 12 });
  comments.open({ path: "other.ts", fingerprint: "f2", side: "new", line: 12 });
  flush();

  expect(comments.at(PATH, "new", 12).map((held) => held.text)).toEqual([
    "on the new side",
  ]);
  expect(comments.at(PATH, "old", 12).length).toBe(1);
  expect(comments.at(PATH, "new", 13)).toEqual([]);
  expect(comments.count(PATH)).toBe(2);
  expect(comments.count("other.ts")).toBe(1);
});

test("a widened comment stays anchored to the line it was opened on", () => {
  const comments = loaded();
  const id = comments.open(anchor(12));
  comments.extend(id, 18);
  flush();

  expect(comments.at(PATH, "new", 12).length).toBe(1);
  expect(comments.at(PATH, "new", 18)).toEqual([]);
});

test("every comment of the working copy is answered in the order they were written", () => {
  const comments = loaded();
  comments.write(comments.open(anchor(12)), "first");
  comments.write(
    comments.open({ path: "other.ts", fingerprint: "f2" }),
    "second"
  );
  flush();

  expect(comments.all().map((held) => held.text)).toEqual(["first", "second"]);

  comments.clear();
  flush();
  expect(comments.all()).toEqual([]);
  expect(comments.count(PATH)).toBe(0);
});
