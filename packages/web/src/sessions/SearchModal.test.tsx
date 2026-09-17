import "../test/dom";

import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSignal, flush, type Accessor } from "solid-js";

import type { SearchHitView, SessionSearch } from "#protocol/ServerEvent";
import { until } from "#core/shared/fixtures/wait";
import { Shell } from "../App";
import { SessionStore } from "../session/SessionStore";
import { Settings } from "../settings/Settings";
import { mountPoint } from "../test/dom";
import { SearchModal } from "./SearchModal";

/**
 * The ⌘K navigator, against a store told what the server would have said. The
 * ranges are the planner's and the row draws them rather than looking for the
 * query itself, so the fixtures below mark words that were never typed.
 */

const SCANNED = 214;

const TITLE_AND_CONTENT: SearchHitView = {
  sessionId: "aaaaaaaa-1111",
  cwd: "/home/ada/dev/pim-agent",
  title: "session-lease: refuse input mid-turn",
  titleRanges: [[8, 13]],
  settledAt: 0,
  snippets: [
    {
      seq: 4,
      role: "user",
      text: "who holds the turn lease when both surfaces are up",
      ranges: [[19, 24]],
    },
    {
      seq: 9,
      role: "assistant",
      text: "the lease is released on the next idle edge",
      ranges: [[4, 9]],
    },
  ],
  total: 2,
};

const CHATTY: SearchHitView = {
  sessionId: "bbbbbbbb-2222",
  cwd: "/home/ada/dev/pim-agent",
  title: "Reworking the sidebar",
  titleRanges: [],
  settledAt: 0,
  snippets: [
    { seq: 1, role: "user", text: "the lease again", ranges: [[4, 9]] },
    { seq: 2, role: "assistant", text: "a lease, once more", ranges: [[2, 7]] },
    {
      seq: 3,
      role: "user",
      text: "and the lease a third time",
      ranges: [[8, 13]],
    },
  ],
  total: 5,
};

const ARCHIVED: SearchHitView = {
  sessionId: "cccccccc-3333",
  cwd: "/home/ada/dev/mmorpg",
  title: "Daemon install",
  titleRanges: [],
  settledAt: 0,
  archived: true,
  snippets: [
    {
      seq: 7,
      role: "user",
      text: "does the lease survive a restart",
      ranges: [[9, 14]],
    },
  ],
  total: 1,
};

/** Nobody named it and it opens with no message of its own: all it has is what it said. */
const NAMELESS: SearchHitView = {
  sessionId: "dddddddd-4444",
  cwd: "/home/ada/dev/pim-agent",
  titleRanges: [],
  settledAt: 0,
  snippets: [
    {
      seq: 2,
      role: "assistant",
      text: "the lease is a file, not a lock",
      ranges: [[4, 9]],
    },
  ],
  total: 1,
};

/** A window onto the middle of a long message: the row owes the reader both ellipses. */
const WINDOWED: SearchHitView = {
  sessionId: "eeeeeeee-5555",
  cwd: "/home/ada/dev/pim-agent",
  title: "Daemon notes",
  titleRanges: [],
  settledAt: 0,
  snippets: [
    {
      seq: 3,
      role: "user",
      text: "whether the lease survives",
      ranges: [[12, 17]],
      cutHead: true,
    },
  ],
  total: 1,
};

/** Named, and the name is the only thing that matched: nothing was said with the word in it. */
const NAMED_ONLY: SearchHitView = {
  sessionId: "ffffffff-6666",
  cwd: "/home/ada/dev/pim-agent",
  title: "Turn lease rework",
  titleRanges: [[5, 10]],
  opening: "Start with the handshake and work outwards",
  settledAt: 0,
  snippets: [],
  total: 0,
};

/** Unnamed, so its opening ask is its title — and the snippet cut from that same ask says nothing new. */
const TITLE_ECHO: SearchHitView = {
  sessionId: "gggggggg-7777",
  cwd: "/home/ada/dev/pim-agent",
  title: "who holds the turn lease when both surfaces are up",
  titleRanges: [[19, 24]],
  settledAt: 0,
  snippets: [
    {
      seq: 1,
      role: "user",
      text: "holds the turn lease when both",
      ranges: [[14, 19]],
      cutHead: true,
    },
    {
      seq: 6,
      role: "assistant",
      text: "the lease is released on the next idle edge",
      ranges: [[4, 9]],
    },
  ],
  total: 2,
};

function answer(hits: readonly SearchHitView[] = []): SessionSearch {
  return { hits, dropped: [], scanned: SCANNED };
}

type Painted = {
  readonly host: HTMLElement;
  /** Every query that reached the store, the warm empty one first. */
  readonly asked: readonly string[];
  readonly switched: readonly string[];
  readonly closes: Accessor<number>;
  readonly store: SessionStore;
};

let dispose: (() => void) | undefined;
let store: SessionStore | undefined;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  store?.dispose();
  store = undefined;
});

function paint(
  reply: (query: string) => SessionSearch = () => answer()
): Painted {
  const target = new SessionStore({ url: "ws://127.0.0.1:1" });
  store = target;
  const asked: string[] = [];
  const switched: string[] = [];
  target.searchSessions = async (query: string) => {
    asked.push(query);
    return reply(query);
  };
  target.switchTo = async (sessionId: string) => {
    switched.push(sessionId);
  };
  const [closes, setCloses] = createSignal(0);
  const host = mountPoint();
  dispose = render(
    () => (
      <SearchModal
        open={true}
        store={target}
        debounceMs={0}
        onClose={() => {
          setCloses((was) => was + 1);
        }}
      />
    ),
    host
  );
  flush();
  return { host, asked, switched, closes, store: target };
}

function box(host: HTMLElement): HTMLInputElement {
  return host.querySelector<HTMLInputElement>('[aria-label="Search query"]')!;
}

function type(host: HTMLElement, text: string): void {
  const input = box(host);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function press(host: HTMLElement, key: string): void {
  box(host).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flush();
}

function rows(host: HTMLElement): readonly HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')];
}

/** The ring the modal draws while the index builds or a query is in flight. */
function spinning(host: HTMLElement): boolean {
  return host.querySelector(".animate-spin") !== null;
}

function marks(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll("mark")].map(
    (mark) => mark.textContent ?? ""
  );
}

/** Which row the keyboard is standing on. */
function active(host: HTMLElement): number {
  return rows(host).findIndex(
    (row) => row.getAttribute("aria-selected") === "true"
  );
}

/** A pointer event on a row, bubbling as the browser bubbles it: all but `mouseenter` do. */
function point(host: HTMLElement, index: number, kind: string): void {
  rows(host)[index]!.dispatchEvent(
    new MouseEvent(kind, { bubbles: kind !== "mouseenter" })
  );
  flush();
}

/** Lets a debounce already set to zero fire, and the answer land on screen. */
async function settle(host: HTMLElement, count: number): Promise<void> {
  await until(() => {
    flush();
    return rows(host).length === count;
  }, `${count} rows`);
}

/** Drains the macrotask a zero debounce would have fired on, for the queries that must not happen. */
async function quiet(): Promise<void> {
  for (let hop = 0; hop < 5; hop += 1) {
    await Bun.sleep(0);
    flush();
  }
}

describe("the search modal", () => {
  test("an empty query lists nothing and says what it will search", async () => {
    const { host, asked } = paint();
    await until(() => {
      flush();
      return host.textContent?.includes(`${SCANNED} sessions`) === true;
    }, "the warm call's count");

    // Not the fifty rows you just looked away from: a prompt, and the scope
    // the sidebar's page of twelve percent cannot promise.
    expect(rows(host)).toHaveLength(0);
    expect(host.textContent).toContain("Search session titles and content");
    expect(host.textContent).toContain("214 sessions, including archived");
    // Opening is the warm call, and the only thing sent so far.
    expect(asked).toEqual([""]);
  });

  test("a one-character query never reaches the server", async () => {
    const { host, asked } = paint(() => answer([TITLE_AND_CONTENT]));

    type(host, "l");
    await quiet();

    expect(asked).toEqual([""]);
    expect(rows(host)).toHaveLength(0);

    // And the second character is what lets it go.
    type(host, "le");
    await settle(host, 1);
    expect(asked).toEqual(["", "le"]);
  });

  test("a session matched by title and by content is one row saying both", async () => {
    const { host } = paint(() => answer([TITLE_AND_CONTENT]));

    type(host, "lease");
    await settle(host, 1);

    const row = rows(host)[0]!;
    expect(row.textContent).toContain("session-lease: refuse input mid-turn");
    // Both halves of why it matched, marked where the planner marked them:
    // the title, and the one message the row makes room for.
    expect(marks(host)).toEqual(["lease", "lease"]);
    expect(row.textContent).toContain("who holds the turn lease");
    expect(row.textContent).not.toContain("the lease is released");
    // Dimmed metadata, never structure.
    expect(row.textContent).toContain("pim-agent");
    expect(row.textContent).not.toContain("/home/ada");
    expect(row.textContent).toMatch(/\d+[smhd]/);
    // One session, one target: every line of the row opens the same file.
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(host.textContent).toContain("1 of 214 sessions");
    expect(host.textContent).not.toContain("1 of 214 sessions, including");
  });

  test("a renamed project is named the way the sidebar names it", async () => {
    const { host, store } = paint(() => answer([TITLE_AND_CONTENT]));
    store.ingest({
      type: "project_meta",
      cwd: "/home/ada/dev/pim-agent",
      label: "Pim",
    });

    type(host, "lease");
    await settle(host, 1);

    const row = rows(host)[0]!;
    expect(row.textContent).toContain("Pim");
    expect(row.textContent).not.toContain("pim-agent");
  });

  test("a chatty session is counted rather than given a second snippet", async () => {
    const { host } = paint(() => answer([CHATTY]));

    type(host, "lease");
    await settle(host, 1);

    const row = rows(host)[0]!;
    expect(row.textContent).toContain("the lease again");
    expect(row.textContent).not.toContain("a lease, once more");
    expect(row.textContent).not.toContain("a third time");
    expect(row.textContent).toContain("5 matches");
  });

  test("a hit with no title reads as the first thing it matched", async () => {
    const { host } = paint(() => answer([NAMELESS]));

    type(host, "lease");
    await settle(host, 1);

    const row = rows(host)[0]!;
    // Promoted, not repeated: the snippet is the row's name now, and the
    // count says what is left rather than counting it twice.
    expect(row.textContent).toContain("the lease is a file, not a lock");
    expect(row.textContent?.match(/the lease is a file/g) ?? []).toHaveLength(
      1
    );
    expect(row.textContent).not.toContain("Untitled");
    expect(row.textContent).not.toContain("matches");
    expect(marks(host)).toEqual(["lease"]);
  });

  test("an archived hit is in scope, and badged", async () => {
    const { host } = paint(() => answer([ARCHIVED]));

    type(host, "lease");
    await settle(host, 1);

    expect(
      rows(host)[0]?.querySelector('[aria-label="Archived"]')
    ).not.toBeNull();
    expect(rows(host)[0]?.textContent).toContain("mmorpg");
  });

  test("a snippet opened mid-message says so, and leaves its tail to the box", async () => {
    const { host } = paint(() => answer([WINDOWED]));

    type(host, "lease");
    await settle(host, 1);

    expect(rows(host)[0]?.textContent).toContain("…whether the lease survives");
    expect(rows(host)[0]?.textContent).not.toContain("survives…");
  });

  test("a row the name alone matched reads its opening ask", async () => {
    const { host } = paint(() => answer([NAMED_ONLY]));

    type(host, "lease");
    await settle(host, 1);

    // Every row is the same height, so the line under the title is never
    // blank while the session has anything at all to say.
    expect(rows(host)[0]?.textContent).toContain(
      "Start with the handshake and work outwards"
    );
  });

  test("a snippet the title already says is skipped for one that adds to it", async () => {
    const { host } = paint(() => answer([TITLE_ECHO]));

    type(host, "lease");
    await settle(host, 1);

    const row = rows(host)[0]!;
    expect(row.textContent).toContain("the lease is released");
    expect(row.textContent).not.toContain("…holds the turn lease when both…");
  });

  test("a word nobody said is named on screen", async () => {
    const { host } = paint(() => ({
      hits: [TITLE_AND_CONTENT],
      dropped: ["quokka"],
      scanned: SCANNED,
    }));

    type(host, "quokka lease");
    await settle(host, 1);

    // A silently dropped word is a search that lies about what it did.
    expect(host.textContent).toContain("searched for lease");
    expect(host.textContent).toContain("no results for quokka");
  });

  test("nothing found says the scope it found nothing in", async () => {
    const { host } = paint(() => answer());

    type(host, "quokka");
    await until(() => {
      flush();
      return host.textContent?.includes("No matches") === true;
    }, "the empty answer");

    expect(host.textContent).toContain(
      "No matches in 214 sessions, including archived."
    );
  });

  /**
   * The scope line is the feature's whole credibility argument, so a search
   * that never happened must say so rather than name a scope of nothing —
   * "0 sessions, including archived" is the lie the modal exists to avoid.
   */
  test("a refused warm call says the search failed instead of a scope of nothing", async () => {
    const { host } = paint(() => {
      throw new Error("not connected");
    });

    await until(() => {
      flush();
      return host.textContent?.includes("The search failed") === true;
    }, "the refusal");

    expect(host.textContent).toContain("The search failed — not connected");
    expect(host.textContent).not.toContain("0 sessions");
    expect(host.textContent).not.toContain("including archived");
    // The warm call is what ends the wait, so a refused one must end it too.
    expect(spinning(host)).toBe(false);
  });

  test("a refused query says the search failed rather than finding no matches", async () => {
    const { host } = paint((query) => {
      if (query !== "") {
        throw new Error("the socket went away");
      }
      return answer();
    });

    await until(() => {
      flush();
      return host.textContent?.includes("214 sessions") === true;
    }, "the warm call's count");

    type(host, "lease");
    await until(() => {
      flush();
      return host.textContent?.includes("The search failed") === true;
    }, "the refusal");

    // The scope the warm call counted is not a scope this query read.
    expect(host.textContent).toContain(
      "The search failed — the socket went away"
    );
    expect(host.textContent).not.toContain("No matches");
    expect(host.textContent).not.toContain("214 sessions");
    expect(rows(host)).toHaveLength(0);
    expect(spinning(host)).toBe(false);
  });

  test("arrows move, Enter opens and Escape closes", async () => {
    const { host, switched, closes } = paint(() =>
      answer([TITLE_AND_CONTENT, CHATTY, ARCHIVED])
    );

    type(host, "lease");
    await settle(host, 3);
    expect(active(host)).toBe(0);

    press(host, "ArrowDown");
    press(host, "ArrowDown");
    expect(active(host)).toBe(2);
    press(host, "ArrowUp");
    expect(active(host)).toBe(1);

    press(host, "Enter");
    expect(switched).toEqual(["bbbbbbbb-2222"]);
    expect(closes()).toBe(1);

    press(host, "Escape");
    expect(closes()).toBe(2);
  });

  test("a row scrolled under a still pointer does not steal the arrows' place", async () => {
    const { host } = paint(() =>
      answer([TITLE_AND_CONTENT, CHATTY, ARCHIVED, NAMELESS])
    );

    type(host, "lease");
    await settle(host, 4);

    press(host, "ArrowDown");
    press(host, "ArrowDown");
    expect(active(host)).toBe(2);

    // Scrolling the list slides a row under the cursor, and the boundary event
    // that follows is the browser's, not the hand's.
    point(host, 0, "mouseenter");
    point(host, 0, "mouseover");
    expect(active(host)).toBe(2);

    press(host, "ArrowDown");
    expect(active(host)).toBe(3);

    point(host, 0, "mousemove");
    expect(active(host)).toBe(0);
  });

  test("clicking a row opens the session it matched in", async () => {
    const { host, switched, closes } = paint(() => answer([TITLE_AND_CONTENT]));

    type(host, "lease");
    await settle(host, 1);

    rows(host)[0]!.querySelector("button")!.click();
    flush();

    expect(switched).toEqual(["aaaaaaaa-1111"]);
    expect(closes()).toBe(1);
  });
});

/** The two ways in, wired where they actually live. */
describe("opening it", () => {
  function shell(): HTMLElement {
    const target = new SessionStore({
      url: "ws://127.0.0.1:1",
      pickerDebounceMs: 0,
    });
    store = target;
    target.searchSessions = async () => answer();
    const host = mountPoint();
    dispose = render(
      () => <Shell store={target} settings={new Settings()} />,
      host
    );
    flush();
    return host;
  }

  function modal(host: HTMLElement): HTMLDialogElement {
    return host.querySelector<HTMLDialogElement>(
      'dialog[aria-label="Search Sessions"]'
    )!;
  }

  test("the sidebar's icon opens it, and so does ⌘K", () => {
    const host = shell();
    expect(modal(host).open).toBe(false);

    host
      .querySelector<HTMLButtonElement>('[aria-label="Search sessions"]')!
      .click();
    flush();
    expect(modal(host).open).toBe(true);

    modal(host)
      .querySelector<HTMLButtonElement>('[aria-label="Close"]')!
      .click();
    flush();
    expect(modal(host).open).toBe(false);

    const stroke = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    globalThis.dispatchEvent(stroke);
    flush();

    expect(stroke.defaultPrevented).toBe(true);
    expect(modal(host).open).toBe(true);
  });
});
