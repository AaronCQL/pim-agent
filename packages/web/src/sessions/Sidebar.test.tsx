import "../test/dom";

import { render } from "@solidjs/web";
import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { flush, untrack } from "solid-js";

import type { CommandDraft } from "#protocol/Command";
import type { ProjectView, SessionSummaryView } from "#protocol/ServerEvent";
import { SessionStore } from "../session/SessionStore";
import { mountPoint } from "../test/dom";
import { Sidebar } from "./Sidebar";

const SESSIONS: readonly SessionSummaryView[] = [
  {
    sessionId: "aaaaaaaa-1111",
    cwd: "/home/ada/dev/pim",
    createdAt: 0,
    settledAt: 0,
    title: "Modernise the string building",
  },
  {
    sessionId: "bbbbbbbb-2222",
    cwd: "/srv/other",
    createdAt: 0,
    settledAt: 0,
  },
];

const PUT_AWAY: SessionSummaryView = {
  sessionId: "cccccccc-3333",
  cwd: "/home/ada/dev/pim",
  createdAt: 0,
  settledAt: 0,
  title: "Put away last week",
  archived: true,
};

type Painted = {
  readonly host: HTMLElement;
  readonly switched: string[];
  readonly sent: CommandDraft[];
  readonly store: SessionStore;
};

function counted(
  sessions: readonly SessionSummaryView[]
): readonly ProjectView[] {
  const tally = new Map<string, number>();
  for (const session of sessions) {
    tally.set(session.cwd, (tally.get(session.cwd) ?? 0) + 1);
  }
  return [...tally].map(([cwd, count]) => ({ cwd, count }));
}

/** Renders against a fake server that keeps pins, folds and labels, and records every command. */
function paint(
  options: {
    readonly onNavigate?: () => void;
    readonly onOpenSearch?: () => void;
    readonly onOpenSettings?: () => void;
    readonly unread?: readonly string[];
    readonly sessions?: readonly SessionSummaryView[];
    /** Overrides the per-project counts. */
    readonly projects?: readonly ProjectView[];
    readonly archived?: readonly SessionSummaryView[];
    readonly pinned?: readonly string[];
    readonly expanded?: readonly string[];
    readonly labels?: Readonly<Record<string, string>>;
    /** Error every non-listing command fails with. */
    readonly refuse?: string;
  } = {}
): Painted {
  const store = new SessionStore({ url: "ws://127.0.0.1:1" });
  const switched: string[] = [];
  const sent: CommandDraft[] = [];
  const live = options.sessions ?? SESSIONS;
  // Newest pin first, as the server keeps them.
  const pins: string[] = [...(options.pinned ?? [])];
  const folds = new Set(options.expanded ?? []);
  const labels = new Map(Object.entries(options.labels ?? {}));
  store.client.send = async (draft) => {
    sent.push(draft);
    if (options.refuse === undefined) {
      if (draft.type === "set_project_pinned") {
        const at = pins.indexOf(draft.cwd);
        if (at !== -1) {
          pins.splice(at, 1);
        }
        if (draft.value) {
          pins.unshift(draft.cwd);
        }
      }
      if (draft.type === "set_project_expanded") {
        if (draft.value) {
          folds.add(draft.cwd);
        } else {
          folds.delete(draft.cwd);
        }
      }
      if (draft.type === "set_pin_order") {
        pins.splice(
          0,
          pins.length,
          ...draft.order.filter((cwd) => pins.includes(cwd))
        );
      }
      if (draft.type === "set_project_label") {
        if (draft.value === null) {
          labels.delete(draft.cwd);
        } else {
          labels.set(draft.cwd, draft.value);
        }
      }
    }
    if (draft.type === "list_sessions") {
      const scope = draft.archived === true ? (options.archived ?? []) : live;
      const answered =
        draft.cwd === undefined
          ? scope
          : scope.filter((session) => session.cwd === draft.cwd);
      return {
        type: "response",
        id: "1",
        success: true,
        projects: (options.projects ?? counted(scope)).map((project) => {
          const rank = pins.indexOf(project.cwd);
          return {
            ...project,
            ...(rank === -1 ? {} : { pinned: true as const, pinRank: rank }),
            ...(folds.has(project.cwd) ? { expanded: true as const } : {}),
            ...(labels.has(project.cwd)
              ? { label: labels.get(project.cwd) }
              : {}),
          };
        }),
        sessions: (draft.perProject === undefined
          ? answered
          : cut(answered, draft.perProject)
        ).map((session) => {
          // Echo live status so a re-list doesn't stop a spinner.
          const status = untrack(() => store.state.activity[session.sessionId]);
          return {
            ...session,
            ...((options.unread ?? []).includes(session.sessionId)
              ? { unread: true }
              : {}),
            ...(pins.includes(session.cwd) ? { pinned: true as const } : {}),
            ...(status === undefined || status === "idle" ? {} : { status }),
          };
        }),
      };
    }
    return options.refuse === undefined
      ? { type: "response", id: "1", success: true }
      : { type: "response", id: "1", success: false, error: options.refuse };
  };
  store.switchTo = async (sessionId) => {
    switched.push(sessionId);
  };
  const host = mountPoint();
  render(
    () => (
      <Sidebar
        store={store}
        {...(options.onNavigate ? { onNavigate: options.onNavigate } : {})}
        {...(options.onOpenSearch
          ? { onOpenSearch: options.onOpenSearch }
          : {})}
        {...(options.onOpenSettings
          ? { onOpenSettings: options.onOpenSettings }
          : {})}
      />
    ),
    host
  );
  flush();
  return { host, switched, sent, store };
}

/** The newest `perProject` sessions of each directory. */
function cut(
  sessions: readonly SessionSummaryView[],
  perProject: number
): readonly SessionSummaryView[] {
  const tally = new Map<string, number>();
  return sessions.filter((session) => {
    const held = (tally.get(session.cwd) ?? 0) + 1;
    tally.set(session.cwd, held);
    return held <= perProject;
  });
}

function draft(sessionId: string, text: string): void {
  localStorage.setItem("pim.drafts", JSON.stringify({ [sessionId]: text }));
}

function unwritten(sessionId: string): void {
  localStorage.setItem(
    "pim.unwritten",
    JSON.stringify({ sessionId, cwd: "/home/ada/dev/pim", sent: false })
  );
}

/** Each row's main (attach) button. */
function bodies(host: HTMLElement): readonly HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("li > button")];
}

function menu(host: HTMLElement, index = 0): HTMLButtonElement {
  return [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label^="Options for"]'),
  ][index]!;
}

/** Unread dots. */
function dots(host: HTMLElement): readonly Element[] {
  return [...host.querySelectorAll('li [class*="bg-indigo-400"]')];
}

function projectMenu(host: HTMLElement, index = 0): HTMLButtonElement {
  return [
    ...host.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Project options for"]'
    ),
  ][index]!;
}

function headings(host: HTMLElement): readonly HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("nav h3 > button")];
}

function heading(host: HTMLElement, index = 0): HTMLButtonElement {
  return headings(host)[index]!;
}

function unfolded(host: HTMLElement): readonly boolean[] {
  return headings(host).map(
    (group) => group.getAttribute("aria-expanded") === "true"
  );
}

/** All rows in a group, hidden or not. */
function under(host: HTMLElement, index = 0): readonly HTMLElement[] {
  return [
    ...heading(host, index)
      .closest("div.group")!
      .querySelectorAll<HTMLElement>("li"),
  ];
}

/** Text of the visible rows in a group. */
function drawn(host: HTMLElement, index = 0): readonly string[] {
  const list = heading(host, index).closest("div.group")!.querySelector("ul")!;
  return list.className.includes("hidden")
    ? []
    : under(host, index)
        .filter((row) => !row.className.includes("hidden"))
        .map((row) => row.textContent ?? "");
}

/** Each group's directory, from the header tooltip. */
function where(host: HTMLElement): readonly string[] {
  return headings(host).map(
    (group) => group.querySelector("[title]")?.getAttribute("title") ?? ""
  );
}

function named(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === label
  );
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

function press(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flush();
}

/** Touch pointerdown, not released. */
function hold(
  target: Element,
  at: { readonly x: number; readonly y: number }
): void {
  target.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      pointerType: "touch",
      clientX: at.x,
      clientY: at.y,
    })
  );
}

function click(target: Element): void {
  target.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true })
  );
  flush();
}

/** Options in the open menu; empty when none is open. */
function verbs(host: HTMLElement): readonly HTMLElement[] {
  const panel = [...host.querySelectorAll("[popover]")].find(
    (element) => !element.className.includes("hidden")
  );
  return panel === undefined
    ? []
    : [...panel.querySelectorAll<HTMLElement>('[role="option"]')];
}

/** Inline style of the open menu. */
function placement(host: HTMLElement): string {
  const panel = [...host.querySelectorAll("[popover]")].find(
    (element) => !element.className.includes("hidden")
  );
  expect(panel).toBeDefined();
  return panel?.getAttribute("style") ?? "";
}

/** Menu options fire on mousedown. */
function choose(host: HTMLElement, label: string): void {
  const row = verbs(host).find((option) => option.textContent === label);
  expect(row).toBeDefined();
  row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  flush();
}

beforeEach(() => {
  localStorage.clear();
});

// `Bun.sleep` never resolves under fake timers, so always restore them.
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

/** Drains microtasks (up to 20 hops) until `done`; works under fake timers. */
async function settle(done: () => boolean = () => false): Promise<void> {
  for (let hop = 0; hop < 20 && !done(); hop += 1) {
    await Promise.resolve();
    flush();
  }
}

async function listed(host: HTMLElement): Promise<void> {
  await settle(() => bodies(host).length > 0);
}

function attach(store: SessionStore, sessionId: string, cwd: string): void {
  store.ingest({
    type: "attached",
    sessionId,
    cwd,
    head: 0,
    pimVersion: "1.2.3",
    piVersion: "0.9.0",
  });
}

test("a group per directory, and one row per session under it", async () => {
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  expect(headings(host)).toHaveLength(2);
  expect(heading(host).textContent).toContain("pim");
  expect(heading(host).querySelector('[title="~/dev/pim"]')).not.toBeNull();
  expect(heading(host, 1).textContent).toContain("other");

  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Modernise the string building");
  // Untitled sessions fall back to the id.
  expect(rows[1]?.textContent).toContain("bbbbbbbb");
  expect(rows[0]?.textContent).toMatch(/\d+[smhd]/);
  expect(rows[0]?.textContent).not.toContain("dev/pim");
});

test("groups stand in the order their newest session settled", async () => {
  const { host } = paint({
    sessions: [
      { sessionId: "c1", cwd: "/srv/api", createdAt: 0, settledAt: 300 },
      {
        sessionId: "a1",
        cwd: "/home/ada/dev/pim",
        createdAt: 0,
        settledAt: 200,
      },
      { sessionId: "b1", cwd: "/srv/other", createdAt: 0, settledAt: 100 },
      {
        sessionId: "a2",
        cwd: "/home/ada/dev/pim",
        createdAt: 0,
        settledAt: 50,
      },
    ],
  });
  await listed(host);

  expect(where(host)).toEqual(["/srv/api", "~/dev/pim", "/srv/other"]);

  const rows = under(host, 1);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("a1");
  expect(rows[1]?.textContent).toContain("a2");
});

test("attaching to a session in a folded project unfolds nothing", async () => {
  const { host, store, sent } = paint();
  await listed(host);

  expect(unfolded(host)).toEqual([false, false]);
  expect(drawn(host, 1)).toEqual([]);

  attach(store, "bbbbbbbb-2222", "/srv/other");
  flush();
  await Bun.sleep(0);
  flush();

  expect(unfolded(host)).toEqual([false, false]);
  expect(sent.map((draft) => draft.type)).not.toContain("set_project_expanded");
  // The current session stays visible under its folded header.
  expect(drawn(host, 1)).toHaveLength(1);
  expect(drawn(host, 1)[0]).toContain("bbbbbbbb");
});

test("a group unfolded by hand is written to the server and read back from it", async () => {
  const { host, sent, store } = paint();
  await listed(host);

  click(heading(host, 1));
  await Bun.sleep(0);
  flush();

  expect(sent.at(-1)).toEqual({
    type: "set_project_expanded",
    cwd: "/srv/other",
    value: true,
  });
  expect(unfolded(host)).toEqual([false, true]);

  // A broadcast from another window refolds it without a re-list.
  store.ingest({ type: "project_meta", cwd: "/srv/other", expanded: false });
  flush();
  expect(unfolded(host)).toEqual([false, false]);
});

test("a fold says nothing about the pin beside it", async () => {
  const { host, store } = paint({ pinned: ["/srv/other"] });
  await listed(host);

  expect(where(host)).toEqual(["/srv/other", "~/dev/pim"]);

  store.ingest({ type: "project_meta", cwd: "/srv/other", expanded: true });
  flush();

  expect(unfolded(host)).toEqual([true, false]);
  expect(where(host)).toEqual(["/srv/other", "~/dev/pim"]);
  expect(
    heading(host).querySelector('[aria-label="Pinned project"]')
  ).not.toBeNull();
});

/** `count` titled sessions in one directory, newest first. */
function many(
  count: number,
  cwd = "/home/ada/dev/pim"
): readonly SessionSummaryView[] {
  return Array.from({ length: count }, (unused, at) => ({
    sessionId: `s${at}`,
    cwd,
    createdAt: 0,
    settledAt: 1000 - at,
    title: `Session ${at}`,
  }));
}

test("a group with more sessions than the page holds reads ten more per press", async () => {
  const navigated: number[] = [];
  const { host, sent } = paint({
    onNavigate: () => navigated.push(1),
    sessions: many(25),
    expanded: ["/home/ada/dev/pim"],
  });
  await listed(host);

  // Ten rows plus "Load more…".
  expect(host.querySelectorAll("li")).toHaveLength(11);
  click(named(host, "Load more…"));
  await Bun.sleep(0);
  flush();

  expect(sent.at(-1)).toEqual({
    type: "list_sessions",
    cwd: "/home/ada/dev/pim",
    perProject: 20,
    limit: 20,
  });
  expect(host.querySelectorAll("li")).toHaveLength(21);

  click(named(host, "Load more…"));
  await Bun.sleep(0);
  flush();

  expect(sent.at(-1)).toEqual({
    type: "list_sessions",
    cwd: "/home/ada/dev/pim",
    perProject: 30,
    limit: 30,
  });
  expect(host.querySelectorAll("li")).toHaveLength(25);
  expect(host.textContent).not.toContain("Load more…");
  expect(navigated).toEqual([]);
});

// The count includes undrawable files, so only a short page ends paging.
test("a directory that answers short retires the button", async () => {
  const { host } = paint({
    sessions: many(12),
    projects: [{ cwd: "/home/ada/dev/pim", count: 14 }],
    expanded: ["/home/ada/dev/pim"],
  });
  await listed(host);

  expect(host.querySelectorAll("li")).toHaveLength(11);
  click(named(host, "Load more…"));
  await Bun.sleep(0);
  flush();

  expect(host.querySelectorAll("li")).toHaveLength(12);
  expect(host.textContent).not.toContain("Load more…");
});

test("a header's `+` starts a session in that directory and unfolds it", async () => {
  const navigated: number[] = [];
  const { host, store, sent } = paint({ onNavigate: () => navigated.push(1) });
  await listed(host);
  const opened: string[] = [];
  store.openDirectory = async (cwd?: string) => {
    opened.push(cwd ?? "");
  };

  const plus = [
    ...host.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="New session in"]'
    ),
  ];
  expect(plus).toHaveLength(2);
  expect(unfolded(host)).toEqual([false, false]);

  click(plus[1]!);

  expect(opened).toEqual(["/srv/other"]);
  expect(unfolded(host)).toEqual([false, true]);
  expect(sent).toContainEqual({
    type: "set_project_expanded",
    cwd: "/srv/other",
    value: true,
  });
  expect(navigated).toEqual([1]);
});

test("a folded group keeps the session being read, as the same element", async () => {
  const { host, store } = paint({
    sessions: many(3),
    expanded: ["/home/ada/dev/pim"],
  });
  await listed(host);

  attach(store, "s1", "/home/ada/dev/pim");
  flush();
  await Bun.sleep(0);
  flush();
  expect(drawn(host)).toHaveLength(3);
  const reading = bodies(host)[1]!;

  click(heading(host));

  expect(unfolded(host)).toEqual([false]);
  expect(drawn(host)).toHaveLength(1);
  expect(drawn(host)[0]).toContain("Session 1");
  expect(bodies(host)[1]).toBe(reading);

  click(heading(host));
  expect(drawn(host)).toHaveLength(3);
  expect(bodies(host)[1]).toBe(reading);
});

test("a pinned project stands above one answered in more recently", async () => {
  const { host, store } = paint({
    pinned: ["/srv/api", "/srv/other"],
    sessions: [
      {
        sessionId: "a1",
        cwd: "/home/ada/dev/pim",
        createdAt: 0,
        settledAt: 300,
      },
      { sessionId: "c1", cwd: "/srv/api", createdAt: 0, settledAt: 200 },
      { sessionId: "b1", cwd: "/srv/other", createdAt: 0, settledAt: 100 },
    ],
  });
  await listed(host);

  expect(where(host)).toEqual(["/srv/api", "/srv/other", "~/dev/pim"]);
  expect(
    headings(host).map(
      (group) => group.querySelector('[aria-label="Pinned project"]') !== null
    )
  ).toEqual([true, true, false]);

  // An unranked pin from another window goes to the end of the pinned.
  store.ingest({
    type: "project_meta",
    cwd: "/home/ada/dev/pim",
    pinned: true,
  });
  flush();
  expect(where(host)).toEqual(["/srv/api", "/srv/other", "~/dev/pim"]);

  store.ingest({
    type: "pins_changed",
    order: ["/home/ada/dev/pim", "/srv/api", "/srv/other"],
  });
  flush();
  expect(where(host)).toEqual(["~/dev/pim", "/srv/api", "/srv/other"]);
});

test("pinned projects hold their order, whichever one was answered in last", async () => {
  const sessions: SessionSummaryView[] = [
    { sessionId: "a1", cwd: "/srv/api", createdAt: 0, settledAt: 100 },
    { sessionId: "b1", cwd: "/srv/web", createdAt: 0, settledAt: 200 },
  ];
  const { host, store } = paint({
    pinned: ["/srv/api", "/srv/web"],
    sessions,
  });
  await listed(host);
  expect(where(host)).toEqual(["/srv/api", "/srv/web"]);

  sessions[0] = { ...sessions[0]!, settledAt: 1_000 };
  sessions[1] = { ...sessions[1]!, settledAt: 2_000 };
  store.ingest({ type: "sessions_changed" });
  await settle();

  expect(where(host)).toEqual(["/srv/api", "/srv/web"]);
});

test("Move up swaps a pin with the one above it and sends the whole order", async () => {
  const { host, sent, store } = paint({
    pinned: ["/srv/api", "/srv/web"],
    sessions: [
      { sessionId: "a1", cwd: "/srv/api", createdAt: 0, settledAt: 100 },
      { sessionId: "b1", cwd: "/srv/web", createdAt: 0, settledAt: 200 },
    ],
  });
  await listed(host);

  // At the ends the move is disabled, not removed.
  click(projectMenu(host, 0));
  expect(verbs(host).map((verb) => verb.textContent)).toEqual([
    "Rename project",
    "Unpin project",
    "Move up",
    "Move down",
  ]);
  expect(verbs(host).map((verb) => verb.getAttribute("aria-disabled"))).toEqual(
    [null, null, "true", null]
  );
  choose(host, "Move up");
  expect(sent.at(-1)?.type).not.toBe("set_pin_order");
  press(projectMenu(host, 0), "Escape");

  click(projectMenu(host, 1));
  choose(host, "Move up");

  expect(sent.at(-1)).toEqual({
    type: "set_pin_order",
    order: ["/srv/web", "/srv/api"],
  });
  expect(where(host)).toEqual(["/srv/web", "/srv/api"]);

  store.ingest({ type: "sessions_changed" });
  await settle();
  expect(where(host)).toEqual(["/srv/web", "/srv/api"]);
  expect(store.pinOrder()).toEqual(["/srv/web", "/srv/api"]);
});

test("pinning a project lifts it at the press and keeps it through a re-list", async () => {
  const navigated: number[] = [];
  const growing: SessionSummaryView[] = [...SESSIONS];
  const { host, sent, store, switched } = paint({
    onNavigate: () => navigated.push(1),
    sessions: growing,
  });
  await listed(host);
  expect(where(host)).toEqual(["~/dev/pim", "/srv/other"]);

  click(projectMenu(host, 1));
  choose(host, "Pin project");

  expect(sent.at(-1)).toEqual({
    type: "set_project_pinned",
    cwd: "/srv/other",
    value: true,
  });
  expect(where(host)).toEqual(["/srv/other", "~/dev/pim"]);
  expect(navigated).toEqual([]);
  expect(switched).toEqual([]);

  growing.push({
    sessionId: "dddddddd-4444",
    cwd: "/home/ada/dev/pim",
    createdAt: 0,
    settledAt: 1,
    title: "Started in the terminal",
  });
  store.ingest({ type: "sessions_changed" });
  flush();
  await settle(() => host.querySelectorAll("li").length >= 3);

  expect(where(host)).toEqual(["/srv/other", "~/dev/pim"]);
  expect(
    heading(host).querySelector('[aria-label="Pinned project"]')
  ).not.toBeNull();
  click(projectMenu(host));
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename project",
    "Unpin project",
    "Move up",
    "Move down",
  ]);
  // The only pin: both moves disabled.
  expect(
    verbs(host).map((option) => option.getAttribute("aria-disabled"))
  ).toEqual([null, null, "true", "true"]);
  choose(host, "Unpin project");
  expect(sent.at(-1)).toEqual({
    type: "set_project_pinned",
    cwd: "/srv/other",
    value: false,
  });
  expect(where(host)).toEqual(["~/dev/pim", "/srv/other"]);
});

test("a refused pin drops the project back where it was and says why", async () => {
  const { host } = paint({ refuse: "the sidecar is read-only" });
  await listed(host);

  click(projectMenu(host, 1));
  choose(host, "Pin project");
  await Bun.sleep(0);
  flush();

  expect(where(host)).toEqual(["~/dev/pim", "/srv/other"]);
  expect(
    heading(host, 1).querySelector('[aria-label="Pinned project"]')
  ).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "the sidecar is read-only"
  );
});

test("a project takes a name of its own, and the directory keeps its own", async () => {
  const { host, sent, store } = paint();
  await listed(host);
  expect(headings(host).map((group) => group.textContent)).toEqual([
    "pim",
    "other",
  ]);

  click(projectMenu(host));
  choose(host, "Rename project");
  const box = (): HTMLInputElement | null =>
    host.querySelector<HTMLInputElement>('[aria-label="Rename ~/dev/pim"]');
  expect(box()?.value).toBe("pim");
  expect(document.activeElement).toBe(box());
  expect(headings(host)).toHaveLength(1);

  box()!.value = "Strings";
  press(box()!, "Escape");
  expect(box()).toBeNull();
  expect(sent.some((command) => command.type === "set_project_label")).toBe(
    false
  );

  click(projectMenu(host));
  choose(host, "Rename project");
  box()!.value = "Strings";
  press(box()!, "Enter");

  expect(sent.at(-1)).toEqual({
    type: "set_project_label",
    cwd: "/home/ada/dev/pim",
    value: "Strings",
  });
  expect(headings(host).map((group) => group.textContent)).toEqual([
    "Strings",
    "other",
  ]);
  // The tooltip still shows the directory.
  expect(where(host)).toEqual(["~/dev/pim", "/srv/other"]);

  store.ingest({ type: "sessions_changed" });
  await settle();
  expect(headings(host).map((group) => group.textContent)).toEqual([
    "Strings",
    "other",
  ]);
  expect(store.projectLabel("/home/ada/dev/pim")).toBe("Strings");
});

test("a project name emptied goes back to the directory's own", async () => {
  const { host, sent, store } = paint({
    labels: { "/home/ada/dev/pim": "Strings" },
  });
  await listed(host);
  expect(headings(host)[0]?.textContent).toBe("Strings");

  click(projectMenu(host));
  choose(host, "Rename project");
  const box = host.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
  box.value = "   ";
  press(box, "Enter");

  expect(sent.at(-1)).toEqual({
    type: "set_project_label",
    cwd: "/home/ada/dev/pim",
    value: null,
  });
  expect(headings(host)[0]?.textContent).toBe("pim");

  store.ingest({ type: "sessions_changed" });
  await settle();
  expect(headings(host)[0]?.textContent).toBe("pim");
  expect(store.projectLabel("/home/ada/dev/pim")).toBeUndefined();
});

test("a refused project name goes back to the one on screen and says why", async () => {
  const { host } = paint({ refuse: "the sidecar is read-only" });
  await listed(host);

  click(projectMenu(host));
  choose(host, "Rename project");
  const box = host.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
  box.value = "Strings";
  press(box, "Enter");
  expect(headings(host)[0]?.textContent).toBe("Strings");

  await Bun.sleep(0);
  flush();

  expect(headings(host)[0]?.textContent).toBe("pim");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "the sidecar is read-only"
  );
});

test("the header's `⋯` and a right-click open the project's verbs, and fold nothing", async () => {
  const { host } = paint({ expanded: ["/home/ada/dev/pim"] });
  await listed(host);

  expect(unfolded(host)).toEqual([true, false]);

  click(projectMenu(host));
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename project",
    "Pin project",
  ]);
  expect(unfolded(host)).toEqual([true, false]);

  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  flush();
  expect(verbs(host)).toHaveLength(0);
  expect(unfolded(host)).toEqual([true, false]);

  heading(host)
    .querySelector('[title="~/dev/pim"]')!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  flush();
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename project",
    "Pin project",
  ]);
  expect(unfolded(host)).toEqual([true, false]);
});

test("the dot marks a session that has answered since anything read it", async () => {
  const { host } = paint();
  await Bun.sleep(0);
  flush();
  expect(dots(host)).toHaveLength(0);

  const { host: marked, store } = paint({ unread: ["aaaaaaaa-1111"] });
  await Bun.sleep(0);
  flush();
  expect(dots(marked)).toHaveLength(1);
  expect(bodies(marked)[0]?.getAttribute("aria-label")).toContain("unread");

  // Read elsewhere: the dot clears without a re-list.
  store.ingest({ type: "session_read", sessionId: "aaaaaaaa-1111" });
  flush();
  expect(dots(marked)).toHaveLength(0);
});

test("a session another process started arrives on sessions_changed", async () => {
  const growing: SessionSummaryView[] = [...SESSIONS];
  const { host, store } = paint({
    sessions: growing,
    expanded: ["/home/ada/dev/pim"],
  });
  await listed(host);

  growing.push({
    sessionId: "cccccccc-3333",
    cwd: "/home/ada/dev/pim",
    createdAt: 0,
    settledAt: 1,
    title: "Started in the terminal",
  });
  store.ingest({ type: "sessions_changed" });
  flush();
  await settle(() => host.querySelectorAll("li").length >= 3);

  expect(host.textContent).toContain("Started in the terminal");
});

test("picking a row attaches to it and tells the host to get out of the way", async () => {
  const navigated: number[] = [];
  const { host, switched } = paint({ onNavigate: () => navigated.push(1) });
  await Bun.sleep(0);
  flush();

  click(bodies(host)[1]!);

  expect(switched).toEqual(["bbbbbbbb-2222"]);
  expect(navigated).toEqual([1]);
});

test("a row's age follows the clock, not the next render", async () => {
  // Before mount, so the component's interval is faked. Sessions settled at 0.
  jest.useFakeTimers();
  setSystemTime(new Date(30_000));
  const { host } = paint();
  await listed(host);
  const age = (): string | undefined =>
    bodies(host)[0]?.querySelector("span:last-child")?.textContent ?? undefined;
  expect(age()).toBe("30s");

  setSystemTime(new Date(90_000));
  jest.advanceTimersByTime(1000);
  flush();
  expect(age()).toBe("1m");
});

test("the header's search and settings buttons call back", () => {
  const opened: number[] = [];
  const searched: number[] = [];
  const { host } = paint({
    onOpenSearch: () => searched.push(1),
    onOpenSettings: () => opened.push(1),
  });
  const header = host.querySelector("h1")!.closest("div")!.parentElement!;
  const labels = [...header.querySelectorAll("button")].map((button) =>
    button.getAttribute("aria-label")
  );

  expect(labels).toEqual(["Search sessions", "Settings"]);

  header
    .querySelector<HTMLButtonElement>('[aria-label="Search sessions"]')!
    .click();
  expect(searched).toHaveLength(1);
  header.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click();
  expect(opened).toHaveLength(1);
});

test("a new chat is a row before it is a file, marked and ageless", async () => {
  unwritten("draft-1");
  draft("draft-1", "rework the sidebar");
  // Unfolded: the seeded draft isn't attached, so a fold would hide it.
  const { host } = paint({ expanded: ["/home/ada/dev/pim"] });
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(3);
  expect(where(host)).toEqual(["~/dev/pim", "/srv/other"]);
  expect(drawn(host)).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("rework the sidebar");
  expect(rows[0]?.innerHTML).toContain("i-griddy-icons:edit");
  expect(rows[0]?.textContent).not.toMatch(/\d+[smhd]/);
  // No file yet, so no options menu.
  expect(rows[0]?.querySelector('[aria-label^="Options for"]')).toBeNull();
  expect(rows[1]?.querySelector('[aria-label^="Options for"]')).not.toBeNull();
});

test("a new chat nobody has typed into is not a row at all", async () => {
  unwritten("draft-1");
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  expect(host.querySelectorAll("li")).toHaveLength(2);
  expect(host.innerHTML).not.toContain("i-griddy-icons:edit");
});

test("the pencil follows the message, onto a listed session's row", async () => {
  draft("bbbbbbbb-2222", "not sent yet");
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows[0]?.innerHTML).not.toContain("i-griddy-icons:edit");
  expect(rows[1]?.innerHTML).toContain("i-griddy-icons:edit");
  expect(rows[1]?.textContent).toMatch(/\d+[smhd]/);
});

test("the unwritten row gives way to the real one, never doubles it", async () => {
  unwritten("aaaaaaaa-1111");
  draft("aaaaaaaa-1111", "already on disk");
  const { host } = paint();
  await Bun.sleep(0);
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Modernise the string building");
});

test("a listed session with no title yet is named by its first message", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  attach(store, "bbbbbbbb-2222", "/srv/other");
  store.ingest({
    seq: 1,
    type: "message",
    messageId: "m1",
    role: "user",
    text: "run the tests",
    timestamp: 0,
  });
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows[1]?.textContent).toContain("run the tests");
  expect(rows[1]?.textContent).not.toContain("bbbbbbbb");
});

test("a name somebody wrote outranks the message the session opened with", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  store.ingest({
    type: "session_meta",
    sessionId: "aaaaaaaa-1111",
    name: "String building",
  });
  flush();

  expect(bodies(host)[0]?.textContent).toContain("String building");
  expect(bodies(host)[0]?.textContent).not.toContain(
    "Modernise the string building"
  );
});

test("a running turn spins where the age would be", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();
  expect(host.innerHTML).not.toContain("animate-spin");

  attach(store, "aaaaaaaa-1111", "/home/ada/dev/pim");
  store.ingest({
    type: "session_state",
    writable: true,
    cwd: "/home/ada/dev/pim",
    model: "m",
    thinking: "off",
    cost: 0,
    status: "thinking",
  });
  flush();

  const row = host.querySelector("li")!;
  expect(row.innerHTML).toContain("animate-spin");
  expect(row.textContent).not.toMatch(/\d+[smhd]/);
});

test("an unattached session spins on server activity", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "tool",
  });
  flush();

  const rows = [...host.querySelectorAll("li")];
  expect(rows[0]?.innerHTML).toContain("animate-spin");
  expect(rows[1]?.innerHTML).not.toContain("animate-spin");
  expect(rows[1]?.textContent).toMatch(/\d+[smhd]/);
});

test("the listing is re-read when a turn ends, so the age is since the reply", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  let listings = 0;
  store.listSessions = async () => {
    listings += 1;
    return {
      sessions: SESSIONS.map((session) =>
        session.sessionId === "aaaaaaaa-1111"
          ? { ...session, settledAt: Date.now() }
          : session
      ),
      projects: counted(SESSIONS),
    };
  };

  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "thinking",
  });
  flush();
  // Only a turn ending re-lists.
  expect(listings).toBe(0);

  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "idle",
  });
  flush();
  await Bun.sleep(0);
  flush();

  expect(listings).toBe(1);
  const row = host.querySelector("li")!;
  expect(row.innerHTML).not.toContain("animate-spin");
  expect(row.textContent).toContain("0s");
});

test("typing into a new chat leaves the rows around it standing", async () => {
  unwritten("draft-1");
  draft("draft-1", "re");
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  attach(store, "draft-1", "/home/ada/dev/pim");
  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "thinking",
  });
  flush();
  await Bun.sleep(0);
  flush();

  const before = [...host.querySelectorAll("li")];
  const spinner = host.querySelector(".animate-spin");
  expect(spinner).not.toBeNull();

  store.setDraftText("rework the sidebar");
  flush();

  // Same elements: a remount would restart the spinner.
  const after = [...host.querySelectorAll("li")];
  expect(after).toHaveLength(before.length);
  for (const [index, row] of after.entries()) {
    expect(row).toBe(before[index]!);
  }
  expect(host.querySelector(".animate-spin")).toBe(spinner!);
  expect(after[0]?.textContent).toContain("rework the sidebar");
});

test("switching moves the highlight without rebuilding the list", async () => {
  const { host, store } = paint();
  await Bun.sleep(0);
  flush();

  store.ingest({
    type: "session_activity",
    sessionId: "aaaaaaaa-1111",
    status: "thinking",
  });
  flush();
  const before = [...host.querySelectorAll("li")];
  const spinner = host.querySelector(".animate-spin");

  attach(store, "bbbbbbbb-2222", "/srv/other");
  flush();
  await Bun.sleep(0);
  flush();

  const after = [...host.querySelectorAll("li")];
  expect(after).toHaveLength(before.length);
  for (const [index, row] of after.entries()) {
    expect(row).toBe(before[index]!);
  }
  expect(host.querySelector(".animate-spin")).toBe(spinner!);
  expect(bodies(host)[1]?.className).toContain("bg-neutral-850");
  expect(bodies(host)[0]?.className).not.toContain("bg-neutral-850");
});

test("the `⋯` and a right-click open the same three verbs", async () => {
  const { host } = paint();
  await listed(host);

  click(menu(host));
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename",
    "Mark unread",
    "Archive",
  ]);
  expect(menu(host).getAttribute("aria-expanded")).toBe("true");

  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  flush();
  expect(verbs(host)).toHaveLength(0);

  bodies(host)[0]!.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true })
  );
  flush();
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename",
    "Mark unread",
    "Archive",
  ]);
});

test("a right-click and a hold both drop the menu from the pointer", async () => {
  jest.useFakeTimers();
  const { host } = paint();
  await listed(host);

  bodies(host)[0]!.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 120 })
  );
  flush();
  expect(placement(host)).toContain("left: 200px");
  expect(placement(host)).toContain("top: 124px");

  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  flush();

  hold([...host.querySelectorAll("li")][1]!, { x: 40, y: 300 });
  jest.advanceTimersByTime(500);
  flush();
  expect(placement(host)).toContain("left: 40px");
  // Offset below the finger by the hold slop plus the gap.
  expect(placement(host)).toContain("top: 314px");

  // The `⋯` anchors to itself again.
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  flush();
  click(menu(host));
  expect(placement(host)).not.toContain("top: 314px");
});

test("a finger held on a row opens its verbs, and the tap that ends it is not one", async () => {
  jest.useFakeTimers();
  const { host, switched } = paint();
  await listed(host);

  const row = [...host.querySelectorAll("li")][0]!;
  hold(row, { x: 20, y: 20 });
  jest.advanceTimersByTime(500);
  flush();
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename",
    "Mark unread",
    "Archive",
  ]);

  row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  click(bodies(host)[0]!);
  expect(switched).toEqual([]);

  click(bodies(host)[0]!);
  expect(switched).toEqual(["aaaaaaaa-1111"]);
});

test("a finger that travels is scrolling the list, not holding a row", async () => {
  jest.useFakeTimers();
  const { host } = paint();
  await listed(host);

  const row = [...host.querySelectorAll("li")][0]!;
  hold(row, { x: 20, y: 20 });
  jest.advanceTimersByTime(200);
  row.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerType: "touch",
      clientX: 22,
      clientY: 90,
    })
  );
  jest.advanceTimersByTime(500);
  flush();

  expect(verbs(host)).toHaveLength(0);
});

test("marking a row unread holds the dot without navigating anywhere", async () => {
  const navigated: number[] = [];
  const { host, sent, switched } = paint({
    onNavigate: () => navigated.push(1),
  });
  await listed(host);

  click(menu(host));
  choose(host, "Mark unread");

  expect(sent.at(-1)).toEqual({
    type: "set_session_unread",
    sessionId: "aaaaaaaa-1111",
    value: true,
  });
  expect(dots(host)).toHaveLength(1);
  expect(navigated).toEqual([]);
  expect(switched).toEqual([]);
  click(menu(host));
  expect(verbs(host).map((option) => option.textContent)).toContain(
    "Mark read"
  );
});

test("archiving takes the row off the live list", async () => {
  const { host, sent } = paint();
  await listed(host);
  expect(bodies(host)).toHaveLength(2);

  click(menu(host));
  choose(host, "Archive");

  expect(sent.at(-1)).toEqual({
    type: "set_session_archived",
    sessionId: "aaaaaaaa-1111",
    value: true,
  });
  expect(verbs(host)).toHaveLength(0);
  expect(bodies(host)).toHaveLength(1);
  expect(host.textContent).not.toContain("Modernise the string building");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("a refused archive puts the row back and says why", async () => {
  const { host } = paint({ refuse: "the session is open in the terminal" });
  await listed(host);

  click(menu(host));
  choose(host, "Archive");
  await Bun.sleep(0);
  flush();

  expect(bodies(host)).toHaveLength(2);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "the session is open in the terminal"
  );
});

test("the footer opens the archived listing, and a row comes back from it", async () => {
  const { host, sent } = paint({ archived: [PUT_AWAY] });
  await listed(host);
  expect(host.textContent).not.toContain("Put away last week");

  click(named(host, "Archived"));
  await settle(() => bodies(host).length === 1);

  expect(sent.at(-1)).toEqual({
    type: "list_sessions",
    archived: true,
    perProject: 10,
  });
  expect(host.textContent).toContain("Put away last week");
  expect(host.textContent).not.toContain("Modernise the string building");
  expect(named(host, "Back to sessions").getAttribute("aria-pressed")).toBe(
    "true"
  );

  click(menu(host));
  expect(verbs(host).map((option) => option.textContent)).toEqual([
    "Rename",
    "Mark unread",
    "Unarchive",
  ]);
  choose(host, "Unarchive");

  expect(sent.at(-1)).toEqual({
    type: "set_session_archived",
    sessionId: "cccccccc-3333",
    value: false,
  });
  expect(host.textContent).not.toContain("Put away last week");
  expect(host.textContent).toContain("Nothing archived.");
});

// No empty-state before the first answer; a seen view repaints from cache.
test("a listing that has yet to answer claims nothing, and a seen one repaints at once", async () => {
  const { host } = paint({ archived: [PUT_AWAY] });

  expect(host.textContent).not.toContain("No sessions yet.");
  await listed(host);

  click(named(host, "Archived"));
  expect(bodies(host)).toHaveLength(0);
  expect(host.textContent).not.toContain("Nothing archived.");
  expect(host.textContent).not.toContain("Modernise the string building");

  await listed(host);
  expect(host.textContent).toContain("Put away last week");

  click(named(host, "Back to sessions"));
  expect(host.textContent).toContain("Modernise the string building");
  expect(host.textContent).not.toContain("No sessions yet.");
  expect(host.textContent).not.toContain("Put away last week");
});

test("an empty list offers a directory to start the first session in", async () => {
  const { host } = paint({ sessions: [] });
  await Bun.sleep(0);
  flush();

  expect(host.querySelectorAll('[aria-label^="New session in"]')).toHaveLength(
    0
  );
  expect(host.querySelector("dialog")?.open).not.toBe(true);

  click(named(host, "New session"));
  expect(host.querySelector("dialog")?.open).toBe(true);
});

test("the keyboard walks the menu and commits the row it stands on", async () => {
  const { host, sent } = paint();
  await listed(host);

  const trigger = menu(host);
  click(trigger);
  // Nothing is selected on open.
  expect(verbs(host).map((verb) => verb.getAttribute("aria-selected"))).toEqual(
    ["false", "false", "false"]
  );
  press(trigger, "ArrowDown");
  expect(verbs(host)[0]?.getAttribute("aria-selected")).toBe("true");
  press(trigger, "End");
  expect(verbs(host)[2]?.getAttribute("aria-selected")).toBe("true");
  press(trigger, "Enter");

  expect(sent.at(-1)).toEqual({
    type: "set_session_archived",
    sessionId: "aaaaaaaa-1111",
    value: true,
  });

  click(menu(host));
  expect(verbs(host)).toHaveLength(3);
  press(menu(host), "Escape");
  expect(verbs(host)).toHaveLength(0);
});

test("Rename writes over the row, commits on Enter and gives up on Escape", async () => {
  const { host, sent } = paint();
  await listed(host);

  click(menu(host));
  choose(host, "Rename");
  const box = (): HTMLInputElement | null =>
    host.querySelector<HTMLInputElement>(
      '[aria-label="Rename Modernise the string building"]'
    );
  expect(box()?.value).toBe("Modernise the string building");
  expect(document.activeElement).toBe(box());
  expect(bodies(host)).toHaveLength(1);

  box()!.value = "Strings";
  press(box()!, "Escape");
  expect(box()).toBeNull();
  expect(bodies(host)).toHaveLength(2);
  expect(sent.some((command) => command.type === "set_session_name")).toBe(
    false
  );

  click(menu(host));
  choose(host, "Rename");
  box()!.value = "Strings";
  press(box()!, "Enter");

  expect(sent.at(-1)).toEqual({
    type: "set_session_name",
    sessionId: "aaaaaaaa-1111",
    value: "Strings",
  });
  expect(box()).toBeNull();
});

test("a name cleared to nothing goes back to the message the session opened with", async () => {
  const { host, sent } = paint();
  await listed(host);

  click(menu(host));
  choose(host, "Rename");
  const box = host.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
  box.value = "   ";
  press(box, "Enter");

  expect(sent.at(-1)).toEqual({
    type: "set_session_name",
    sessionId: "aaaaaaaa-1111",
    value: null,
  });
});

test("a rename is on the row before the server answers, and is taken back when it refuses", async () => {
  const { host } = paint({ refuse: "the session is mid-turn" });
  await listed(host);

  click(menu(host));
  choose(host, "Rename");
  const box = host.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
  box.value = "Strings";
  press(box, "Enter");

  expect(bodies(host)[0]?.textContent).toContain("Strings");

  await Bun.sleep(0);
  flush();

  expect(bodies(host)[0]?.textContent).toContain(
    "Modernise the string building"
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "the session is mid-turn"
  );
});

test("a name being typed survives the listing a running session keeps provoking", async () => {
  const { host, store, sent } = paint();
  await listed(host);

  click(menu(host));
  choose(host, "Rename");
  const box = (): HTMLInputElement =>
    host.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
  box().value = "Strings";

  store.ingest({ type: "sessions_changed" });
  flush();
  await settle();

  expect(box().value).toBe("Strings");
  expect(document.activeElement).toBe(box());

  press(box(), "Enter");
  expect(sent.at(-1)).toEqual({
    type: "set_session_name",
    sessionId: "aaaaaaaa-1111",
    value: "Strings",
  });
});

test("a name left as it was says nothing to the server", async () => {
  const { host, sent } = paint();
  await listed(host);

  click(menu(host));
  choose(host, "Rename");
  const box = host.querySelector<HTMLInputElement>('[aria-label^="Rename "]')!;
  press(box, "Enter");

  expect(sent.some((command) => command.type === "set_session_name")).toBe(
    false
  );
});
