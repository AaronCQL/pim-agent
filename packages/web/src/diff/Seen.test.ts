import "../test/dom";

import { createComponent, render } from "@solidjs/web";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { flush } from "solid-js";

import type { ChangeList, ChangeSummary } from "#protocol/Diff";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { until } from "../test/gateway";
import { DiffOverlay } from "./DiffOverlay";
import { FileRow } from "./FileRow";
import { Seen } from "./Seen";

/**
 * A tick is stored as the fingerprint it was made at, so the file it describes
 * is the file that was read: an edit since gives the row another fingerprint
 * and the tick is gone without anyone clearing it.
 */

const KEY = "pim.diff.seen";
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
function loaded(files: readonly ChangeSummary[]): Seen {
  const seen = new Seen();
  seen.load(REPO, files);
  flush();
  return seen;
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

test("a tick survives the overlay that made it", () => {
  const files = [summary("alpha.ts", "f1"), summary("src/beta.ts", "f2")];
  const seen = loaded(files);
  seen.toggle(files[0]!);
  flush();
  expect(seen.isSeen(files[0]!)).toBe(true);

  const reopened = loaded(files);
  expect(reopened.isSeen(files[0]!)).toBe(true);
  expect(reopened.isSeen(files[1]!)).toBe(false);
  expect(stored()[REPO]).toEqual({ "alpha.ts": "f1" });
});

test("a tick is undone by a second click", () => {
  const files = [summary("alpha.ts", "f1")];
  const seen = loaded(files);
  seen.toggle(files[0]!);
  seen.toggle(files[0]!);
  flush();
  expect(seen.isSeen(files[0]!)).toBe(false);
  expect(stored()[REPO]).toBeUndefined();
});

test("an edit to a ticked file clears the tick by itself", () => {
  const before = summary("alpha.ts", "f1");
  const seen = loaded([before]);
  seen.toggle(before);
  flush();

  const after = summary("alpha.ts", "f2");
  expect(seen.isSeen(after)).toBe(false);

  const reopened = loaded([after]);
  expect(reopened.isSeen(after)).toBe(false);
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
  const seen = loaded(files);

  expect(seen.isSeen(files[0]!)).toBe(true);
  expect(stored()).toEqual({
    [REPO]: { "alpha.ts": "f1" },
    "/home/dev/other": { "kept.ts": "f0" },
  });
});

test("a working copy with nothing ticked leaves no entry behind", () => {
  const seen = loaded([summary("alpha.ts", "f1")]);
  seen.clear();
  flush();
  expect(stored()).toEqual({});
});

test("a full quota is not an error a click can raise", () => {
  const files = [summary("alpha.ts", "f1")];
  const seen = loaded(files);
  const refused = withFullQuota(() => {
    expect(() => {
      seen.toggle(files[0]!);
    }).not.toThrow();
    flush();
    expect(seen.isSeen(files[0]!)).toBe(true);
    expect(() => {
      seen.markAll(files);
    }).not.toThrow();
    expect(() => {
      seen.clear();
    }).not.toThrow();
  });

  expect(refused).toBe(3);
});

test("the counter tracks every way a row is ticked", () => {
  const files = [
    summary("alpha.ts", "f1"),
    summary("src/beta.ts", "f2"),
    summary("gamma.ts", "f3"),
  ];
  const seen = loaded(files);
  expect(seen.count(files)).toBe(0);

  seen.toggle(files[0]!);
  flush();
  expect(seen.count(files)).toBe(1);

  seen.markAll(files);
  flush();
  expect(seen.count(files)).toBe(3);

  seen.clear();
  flush();
  expect(seen.count(files)).toBe(0);
});

test("ticking a row collapses it, dims it, and fills its box", () => {
  const files = [summary("alpha.ts", "f1")];
  const seen = loaded(files);
  const host = mountPoint();
  dispose = render(
    () =>
      createComponent(FileRow, {
        file: files[0]!,
        state: undefined,
        get seen() {
          return seen.isSeen(files[0]!);
        },
        onExpand: () => {},
        onToggleSeen: () => {
          seen.toggle(files[0]!);
        },
      }),
    host
  );
  flush();

  const row = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  const box = host.querySelector<HTMLButtonElement>("[role='checkbox']")!;
  row.click();
  flush();
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(box.innerHTML).toContain("i-griddy-icons:checkbox");
  expect(box.innerHTML).not.toContain("checkbox-filled");

  box.click();
  flush();
  expect(box.getAttribute("aria-checked")).toBe("true");
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(row.className).toContain("opacity-50");
  expect(box.innerHTML).toContain("i-griddy-icons:checkbox-filled");
});

/** The overlay against a store that answers the change list and nothing else. */
function store(answer: () => Promise<ChangeList>): SessionStore {
  const session = new SessionStore({ url: "ws://127.0.0.1:1", cwd: REPO });
  spyOn(session, "listChanges").mockImplementation(answer);
  return session;
}

function paint(session: SessionStore): HTMLElement {
  dispose?.();
  const host = mountPoint();
  dispose = render(
    () =>
      createComponent(DiffOverlay, {
        open: true,
        store: session,
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
  return host.querySelector<HTMLButtonElement>(`[aria-label='Seen ${path}']`)!;
}

function press(host: HTMLElement, label: string): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find(
    (button) => button.textContent === label
  )!;
}

function order(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll("[role='checkbox']")].map(
    (button) => button.getAttribute("aria-label") ?? ""
  );
}

test("a tick outlives the overlay that made it", async () => {
  const files = [summary("alpha.ts", "f1"), summary("src/beta.ts", "f2")];
  const session = store(() => Promise.resolve(changes(files)));
  const host = paint(session);
  await settle(() => order(host).length === 2, "both rows");

  box(host, "alpha.ts").click();
  flush();
  expect(host.textContent).toContain("1 of 2 reviewed");
  expect(order(host)).toEqual(["Seen alpha.ts", "Seen src/beta.ts"]);

  const reopened = paint(session);
  await settle(() => order(reopened).length === 2, "both rows again");
  expect(box(reopened, "alpha.ts").getAttribute("aria-checked")).toBe("true");
  expect(box(reopened, "src/beta.ts").getAttribute("aria-checked")).toBe(
    "false"
  );
  expect(reopened.textContent).toContain("1 of 2 reviewed");
  session.dispose();
});

test("the header ticks every row and takes it all back, in git's order", async () => {
  const files = [summary("alpha.ts", "f1"), summary("src/beta.ts", "f2")];
  const session = store(() => Promise.resolve(changes(files)));
  const host = paint(session);
  await settle(() => order(host).length === 2, "both rows");

  press(host, "mark all seen").click();
  flush();
  expect(host.textContent).toContain("2 of 2 reviewed");
  expect(order(host)).toEqual(["Seen alpha.ts", "Seen src/beta.ts"]);
  expect(stored()[REPO]).toEqual({ "alpha.ts": "f1", "src/beta.ts": "f2" });

  press(host, "clear").click();
  flush();
  expect(host.textContent).toContain("0 of 2 reviewed");
  expect(stored()[REPO]).toBeUndefined();
  expect(order(host)).toEqual(["Seen alpha.ts", "Seen src/beta.ts"]);
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
  expect(host.textContent).toContain("1 of 1 reviewed");
  session.dispose();
});
