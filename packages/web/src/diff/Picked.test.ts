import "../test/dom";

import { createComponent, render } from "@solidjs/web";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { flush } from "solid-js";

import type { ChangeList, ChangeSummary } from "#protocol/Diff";
import { SessionStore } from "../session/SessionStore";
import { Settings } from "../settings/Settings";
import { mountPoint } from "../test/dom";
import { until } from "../test/gateway";
import { DiffStore } from "./DiffStore";
import { DiffView } from "./DiffView";
import { FileRow } from "./FileRow";
import { Picked } from "./Picked";

/**
 * A pick is stored as the fingerprint it was made at, so the file it commits
 * is the file that was read: an edit since gives the row another fingerprint
 * and the pick is gone without anyone clearing it.
 */

const KEY = "pim.diff.picked";
const SEEN = "pim.diff.seen";
const REPO = "/home/dev/repo";

let dispose: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  mock.restore();
});

function summary(path: string, fingerprint: string): ChangeSummary {
  return { path, status: "modified", added: 1, removed: 1, fingerprint };
}

function changes(files: readonly ChangeSummary[]): ChangeList {
  return {
    base: { kind: "worktree" },
    files,
    added: files.length,
    removed: files.length,
  };
}

function stored(): Record<string, Record<string, string>> {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<
    string,
    Record<string, string>
  >;
}

/** A loaded overlay's worth of state for one working copy. */
function loaded(files: readonly ChangeSummary[]): Picked {
  const picked = new Picked();
  picked.load(REPO, files);
  flush();
  return picked;
}

/** Storage that refuses every write, as a filled-up one does. */
function withFullQuota(run: () => void): number {
  const real = localStorage;
  let refused = 0;
  const full: Storage = {
    ...real,
    getItem: (key: string) => real.getItem(key),
    removeItem: (key: string) => real.removeItem(key),
    clear: () => {
      real.clear();
    },
    key: (index: number) => real.key(index),
    get length() {
      return real.length;
    },
    setItem: () => {
      refused += 1;
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: full,
  });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: real,
    });
  }
  return refused;
}

test("a pick survives the overlay that made it", () => {
  const files = [summary("alpha.ts", "f1"), summary("src/beta.ts", "f2")];
  const picked = loaded(files);
  picked.toggle(files[0]!);
  flush();
  expect(picked.isPicked(files[0]!)).toBe(true);

  const reopened = loaded(files);
  expect(reopened.isPicked(files[0]!)).toBe(true);
  expect(reopened.isPicked(files[1]!)).toBe(false);
  expect(reopened.count()).toBe(1);
  expect(stored()[REPO]).toEqual({ "alpha.ts": "f1" });
});

test("a pick is undone by a second click", () => {
  const files = [summary("alpha.ts", "f1")];
  const picked = loaded(files);
  picked.toggle(files[0]!);
  picked.toggle(files[0]!);
  flush();
  expect(picked.isPicked(files[0]!)).toBe(false);
  expect(picked.count()).toBe(0);
  expect(stored()[REPO]).toBeUndefined();
});

test("an edit to a picked file clears the pick by itself", () => {
  const before = summary("alpha.ts", "f1");
  const picked = loaded([before]);
  picked.toggle(before);
  flush();

  const after = summary("alpha.ts", "f2");
  expect(picked.isPicked(after)).toBe(false);

  const reopened = loaded([after]);
  expect(reopened.isPicked(after)).toBe(false);
  expect(stored()[REPO]).toEqual({ "alpha.ts": "f1" });
});

test("loading forgets paths this list no longer names, and nobody else's", () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      [REPO]: { "alpha.ts": "f1", "gone.ts": "f9" },
      "/home/dev/other": { "kept.ts": "f0" },
    })
  );
  const files = [summary("alpha.ts", "f1")];
  const picked = loaded(files);

  expect(picked.isPicked(files[0]!)).toBe(true);
  expect(picked.count()).toBe(1);
  expect(stored()).toEqual({
    [REPO]: { "alpha.ts": "f1" },
    "/home/dev/other": { "kept.ts": "f0" },
  });
});

/** The tick used to mean `seen`; its key is dropped rather than left to rot. */
test("the ticks of the old meaning are forgotten, not inherited", () => {
  localStorage.setItem(SEEN, JSON.stringify({ [REPO]: { "alpha.ts": "f1" } }));
  const files = [summary("alpha.ts", "f1")];
  const picked = loaded(files);

  expect(localStorage.getItem(SEEN)).toBeNull();
  expect(picked.isPicked(files[0]!)).toBe(false);
  expect(picked.count()).toBe(0);
});

test("every file is picked at once, and cleared at once", () => {
  const files = [
    summary("alpha.ts", "f1"),
    summary("src/beta.ts", "f2"),
    summary("gamma.ts", "f3"),
  ];
  const picked = loaded(files);
  picked.toggle(files[1]!);
  flush();
  expect(picked.count()).toBe(1);

  picked.pickAll(files);
  flush();
  expect(picked.count()).toBe(3);
  expect(files.every((file) => picked.isPicked(file))).toBe(true);
  expect(stored()[REPO]).toEqual({
    "alpha.ts": "f1",
    "src/beta.ts": "f2",
    "gamma.ts": "f3",
  });

  picked.clear();
  flush();
  expect(picked.count()).toBe(0);
  expect(files.some((file) => picked.isPicked(file))).toBe(false);
  expect(stored()[REPO]).toBeUndefined();
});

test("a full quota is not an error a click can raise", () => {
  const files = [summary("alpha.ts", "f1")];
  const picked = loaded(files);
  const refused = withFullQuota(() => {
    expect(() => {
      picked.toggle(files[0]!);
    }).not.toThrow();
    flush();
    expect(picked.isPicked(files[0]!)).toBe(true);
    expect(() => {
      picked.clear();
    }).not.toThrow();
  });

  expect(refused).toBe(2);
});

test("picking a row collapses it and fills its box, at full contrast", () => {
  const files = [summary("alpha.ts", "f1")];
  const picked = loaded(files);
  const host = mountPoint();
  dispose = render(
    () =>
      createComponent(FileRow, {
        file: files[0]!,
        state: undefined,
        split: false,
        get picked() {
          return picked.isPicked(files[0]!);
        },
        onExpand: () => {},
        onOpen: () => {},
        onTogglePicked: () => {
          picked.toggle(files[0]!);
        },
      }),
    host
  );
  flush();

  const row = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  const box = host.querySelector<HTMLButtonElement>("[role='checkbox']")!;
  expect(box.getAttribute("title")).toBe("Include in the commit");
  expect(host.innerHTML).not.toContain("chevron");
  row.click();
  flush();
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(box.innerHTML).toContain("i-griddy-icons:checkbox");
  expect(box.innerHTML).not.toContain("checkbox-filled");

  box.click();
  flush();
  expect(box.getAttribute("aria-checked")).toBe("true");
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(row.className).not.toContain("opacity-50");
  expect(box.innerHTML).toContain("i-griddy-icons:checkbox-filled");
});

/** The view against a store that answers the change list and nothing else. */
function store(answer: () => Promise<ChangeList>): SessionStore {
  const session = new SessionStore({ url: "ws://127.0.0.1:1", cwd: REPO });
  spyOn(session, "listChanges").mockImplementation(answer);
  return session;
}

function paint(session: SessionStore, picked = new Picked()): HTMLElement {
  dispose?.();
  const host = mountPoint();
  dispose = render(
    () =>
      createComponent(DiffView, {
        diff: new DiffStore(session),
        picked,
        settings: new Settings(),
        inset: 0,
        onClose: () => {},
      }),
    host
  );
  flush();
  return host;
}

function settle(test: () => boolean, label: string): Promise<void> {
  return until(() => {
    flush();
    return test();
  }, label);
}

function box(host: HTMLElement, path: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[aria-label='Pick ${path}']`)!;
}

function order(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll("[role='checkbox']")].map(
    (button) => button.getAttribute("aria-label") ?? ""
  );
}

function all(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(
    "[aria-label='Pick every file'], [aria-label='Clear every pick']"
  )!;
}

test("a pick outlives the overlay that made it", async () => {
  const files = [summary("alpha.ts", "f1"), summary("src/beta.ts", "f2")];
  const session = store(() => Promise.resolve(changes(files)));
  const host = paint(session);
  await settle(() => order(host).length === 2, "both rows");

  box(host, "alpha.ts").click();
  flush();
  expect(order(host)).toEqual(["Pick alpha.ts", "Pick src/beta.ts"]);

  const reopened = paint(session);
  await settle(() => order(reopened).length === 2, "both rows again");
  expect(box(reopened, "alpha.ts").getAttribute("aria-checked")).toBe("true");
  expect(box(reopened, "src/beta.ts").getAttribute("aria-checked")).toBe(
    "false"
  );
  session.dispose();
});

/** An overlay that has not read a list yet has no grounds to forget anything. */
test("a list still in flight is not a working copy with nothing in it", async () => {
  localStorage.setItem(KEY, JSON.stringify({ [REPO]: { "alpha.ts": "f1" } }));
  const files = [summary("alpha.ts", "f1")];
  let land: ((list: ChangeList) => void) | undefined;
  const session = store(
    () =>
      new Promise<ChangeList>((resolve) => {
        land = resolve;
      })
  );
  const host = paint(session);

  await settle(() => land !== undefined, "the list to be asked for");
  expect(stored()[REPO]).toEqual({ "alpha.ts": "f1" });
  land!(changes(files));

  await settle(() => order(host).length === 1, "the row");
  expect(box(host, "alpha.ts").getAttribute("aria-checked")).toBe("true");
  session.dispose();
});

test("the header counts the picks, and its button makes them all or none", async () => {
  const files = [summary("alpha.ts", "f1"), summary("src/beta.ts", "f2")];
  const session = store(() => Promise.resolve(changes(files)));
  const host = paint(session);
  await settle(() => order(host).length === 2, "both rows");

  const header = host.querySelector("header")!;
  expect(header.textContent).toContain("0/2");

  all(host).click();
  flush();
  expect(header.textContent).toContain("2/2");
  expect(all(host).getAttribute("aria-label")).toBe("Clear every pick");
  expect(order(host).length).toBe(2);
  expect(box(host, "src/beta.ts").getAttribute("aria-checked")).toBe("true");

  all(host).click();
  flush();
  expect(header.textContent).toContain("0/2");
  expect(all(host).getAttribute("aria-label")).toBe("Pick every file");
  expect(box(host, "alpha.ts").getAttribute("aria-checked")).toBe("false");
  session.dispose();
});

/** Six hundred rows picked at once: the count is carried, never reduced over the list. */
test("a long list is picked whole without a word from Solid", async () => {
  const files = Array.from({ length: 600 }, (_, at) =>
    summary(`src/file-${at}.ts`, `f${at}`)
  );
  const session = store(() => Promise.resolve(changes(files)));
  const host = paint(session);
  await settle(() => order(host).length === 500, "the first page");

  all(host).click();
  flush();
  expect(host.querySelector("header")?.textContent).toContain("600/600");
  expect(box(host, "src/file-0.ts").getAttribute("aria-checked")).toBe("true");
  session.dispose();
});
